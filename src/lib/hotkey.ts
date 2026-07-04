/**
 * Hotkey wiring for the main window.
 *
 * The Rust side registers the global shortcut and emits `hotkey:down`
 * / `hotkey:up`. This module:
 *
 * - Persists the user's hotkey + PTT preference in localStorage.
 * - Re-registers the hotkey on app start.
 * - Translates events into start/stop calls on the recording bridge.
 *
 * Per plan §13 active-window lookup happens *at hotkey press time*.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { startRecording, stopRecording } from "./recording-bridge";
import { resolveModeAtPress } from "./modeResolver";
import { isHotkeyPaused } from "./preferences";
import { isOnboardingComplete } from "./store/useOnboarding";

const LS_HOTKEY = "sw.hotkey.spec";
const LS_PTT = "sw.hotkey.ptt";
// On macOS ⌘+Space is Spotlight — pick something the user can use out of the box.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const DEFAULT_SPEC = IS_MAC ? "Control+Shift+Space" : "CommandOrControl+Space";

export interface HotkeyConfig {
  spec: string;
  /** push-to-talk: hold to record, release to stop. */
  pushToTalk: boolean;
}

const KEY_LABEL: Record<string, string> = IS_MAC
  ? { CommandOrControl: "⌘", Control: "⌃", Shift: "⇧", Alt: "⌥", Super: "⌘", Fn: "fn" }
  : { CommandOrControl: "Ctrl", Control: "Ctrl", Super: "Win" };

/** Spec → human key labels, e.g. "Control+Shift+Space" → ["⌃","⇧","Space"]. */
export function hotkeyDisplayParts(spec: string): string[] {
  return spec
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => KEY_LABEL[p] ?? p);
}

export interface ActiveWindow {
  exe: string;
  exe_path: string;
  title: string;
}

export function loadHotkeyConfig(): HotkeyConfig {
  const spec = localStorage.getItem(LS_HOTKEY) ?? DEFAULT_SPEC;
  const ptt = localStorage.getItem(LS_PTT);
  return { spec, pushToTalk: ptt === null ? true : ptt === "1" };
}

export function saveHotkeyConfig(cfg: HotkeyConfig) {
  localStorage.setItem(LS_HOTKEY, cfg.spec);
  localStorage.setItem(LS_PTT, cfg.pushToTalk ? "1" : "0");
}

export function isSingleKeySpec(spec: string): boolean {
  return spec.split("+").map((p) => p.trim()).filter(Boolean).length === 1;
}

export function isMacSingleKeySpec(spec: string): boolean {
  return IS_MAC && isSingleKeySpec(spec);
}

export function usesHoldToTalk(cfg: HotkeyConfig): boolean {
  return cfg.pushToTalk || isMacSingleKeySpec(cfg.spec);
}

export async function applyHotkey(spec: string): Promise<void> {
  await invoke("set_hotkey", { spec });
}

export async function clearHotkey(): Promise<void> {
  await invoke("clear_hotkey");
}

export async function getActiveWindow(): Promise<ActiveWindow> {
  return invoke<ActiveWindow>("get_active_window");
}

/**
 * Install the global key-down / key-up listeners. Returns an unlisten
 * function that removes both subscriptions.
 */
export async function installHotkeyListeners(): Promise<UnlistenFn> {
  // Re-apply the persisted hotkey at boot so the registration matches
  // whatever the user last picked (or the platform default if nothing
  // is saved). Rust's `install_default` registers `Ctrl+Space` but the
  // user may have rebound — or a previous session's recorder may have
  // left the slot empty after a clear+capture.
  const cfg0 = loadHotkeyConfig();
  void applyHotkey(cfg0.spec).catch(() => {});

  // Toggle mode tracks "are we currently recording?" across taps.
  let toggleRecording = false;
  let holdToTalkRecording = false;

  const offDown = await listen("hotkey:down", async () => {
    if (isHotkeyPaused()) return;
    if (!isOnboardingComplete()) return;
    const pressedAt = Date.now();
    const cfg = loadHotkeyConfig();
    const { mode, activeWindow } = await resolveModeAtPress();
    if (!mode) {
      console.warn("[Verbatim AI] no modes available — sign in / hydrate first.");
      return;
    }
    // Window titles can contain sensitive content — dev builds only.
    if (import.meta.env.DEV && activeWindow?.exe) {
      console.debug(
        `[Verbatim AI] ${activeWindow.exe} → ${mode.name}${
          activeWindow.title ? ` (window: "${activeWindow.title}")` : ""
        }`,
      );
    }

    if (usesHoldToTalk(cfg)) {
      if (holdToTalkRecording) return;
      holdToTalkRecording = true;
      try {
        await startRecording(mode.name, mode.id, pressedAt);
      } catch (e) {
        holdToTalkRecording = false;
        throw e;
      }
    } else {
      if (toggleRecording) {
        toggleRecording = false;
        await stopRecording();
      } else {
        toggleRecording = true;
        await startRecording(mode.name, mode.id, pressedAt);
      }
    }
  });

  const offUp = await listen("hotkey:up", async () => {
    if (isHotkeyPaused()) return;
    const cfg = loadHotkeyConfig();
    if (usesHoldToTalk(cfg) && holdToTalkRecording) {
      holdToTalkRecording = false;
      await stopRecording();
    }
  });

  return () => {
    offDown();
    offUp();
  };
}
