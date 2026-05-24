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
const DEFAULT_SPEC = "CommandOrControl+Space";

export interface HotkeyConfig {
  spec: string;
  /** push-to-talk: hold to record, release to stop. */
  pushToTalk: boolean;
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
  // Toggle mode tracks "are we currently recording?" across taps.
  let toggleRecording = false;

  const offDown = await listen("hotkey:down", async () => {
    if (isHotkeyPaused()) return;
    if (!isOnboardingComplete()) return;
    const cfg = loadHotkeyConfig();
    const { mode, activeWindow } = await resolveModeAtPress();
    if (!mode) {
      console.warn("[Verbatim AI] no modes available — sign in / hydrate first.");
      return;
    }
    if (activeWindow?.exe) {
      console.debug(
        `[Verbatim AI] ${activeWindow.exe} → ${mode.name}${
          activeWindow.title ? ` (window: "${activeWindow.title}")` : ""
        }`,
      );
    }

    if (cfg.pushToTalk) {
      await startRecording(mode.name, mode.id);
    } else {
      if (toggleRecording) {
        toggleRecording = false;
        await stopRecording();
      } else {
        toggleRecording = true;
        await startRecording(mode.name, mode.id);
      }
    }
  });

  const offUp = await listen("hotkey:up", async () => {
    if (isHotkeyPaused()) return;
    const cfg = loadHotkeyConfig();
    if (cfg.pushToTalk) {
      await stopRecording();
    }
  });

  return () => {
    offDown();
    offUp();
  };
}
