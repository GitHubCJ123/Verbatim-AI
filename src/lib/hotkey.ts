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
import { startRecording, stopRecording, cancelRecording } from "./recording-bridge";
import { resolveModeAtPress } from "./modeResolver";
import { isHotkeyPaused } from "./preferences";
import { syncNativeCaptureArm } from "./nativeAudio";
import { isOnboardingComplete } from "./store/useOnboarding";
import {
  ensureWhisperEngineReady,
  getAiProviderKind,
  getLocalWhisperEngine,
  getLocalWhisperTier,
  type WhisperModelId,
} from "./ai/localWhisper";

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
  ? {
      CommandOrControl: "⌘",
      Control: "⌃",
      Shift: "⇧",
      Alt: "⌥",
      Super: "⌘",
      Fn: "fn",
      RightCommand: "right ⌘",
    }
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

/**
 * True for a function-key name (F1–F24). Function keys are the one class
 * of key that is safe to bind on its own as a *global* shortcut on
 * non-macOS: a bare letter/space would hijack ordinary typing, but a
 * function key generally does not.
 */
export function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key.trim());
}

/** True if `spec` is a single function key, e.g. `"F6"`. */
export function isFunctionKeySpec(spec: string): boolean {
  return isSingleKeySpec(spec) && isFunctionKey(spec);
}

/** Bare modifier-like keys that must stay hold-only (a stray tap shouldn't start dictation). */
export function isForcedHoldSpec(spec: string): boolean {
  return spec === "Fn" || spec === "RightCommand";
}

export function usesHoldToTalk(cfg: HotkeyConfig): boolean {
  return isForcedHoldSpec(cfg.spec) || cfg.pushToTalk;
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

function preloadWhisperIfNeeded(mode: {
  transcribeProviderOverride?: string | null;
  whisperTierOverride?: string | null;
}): void {
  const kind = mode.transcribeProviderOverride ?? getAiProviderKind();
  if (kind !== "local-whisper" || getLocalWhisperEngine() === "cli") return;

  const tier = (mode.whisperTierOverride ?? getLocalWhisperTier()) as WhisperModelId;
  void ensureWhisperEngineReady(tier).catch((e) => {
    if (import.meta.env.DEV) {
      console.debug("[Verbatim AI] local whisper preload skipped", e);
    }
  });
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
  void syncNativeCaptureArm().catch(() => {});

  // A single serialized recording state machine drives BOTH hold and
  // toggle modes. Design notes — each guards a real event interleaving:
  //  - The session's kind (`activeKind`) is captured *synchronously* in the
  //    non-async down listener, before any `await`, so a fast key release
  //    that lands while async startup is still in flight is never dropped
  //    (`pendingStop` records it; we stop as soon as startup resolves).
  //  - `gen` tags each start attempt; cancel and every fresh start bump it.
  //    An in-flight `startFlow`/`stopFlow` re-checks `gen` after each await
  //    and bails if it moved on, so a superseded attempt can never
  //    double-start or reset a newer session's state.
  //  - Stopping keys off the *active session's* `activeKind`, never the
  //    current config (which the user can change mid-recording).
  let recState: "idle" | "starting" | "recording" | "stopping" = "idle";
  let pendingStop = false;
  let activeKind: "hold" | "toggle" | null = null;
  let gen = 0;

  const resetState = () => {
    recState = "idle";
    pendingStop = false;
    activeKind = null;
  };

  async function startFlow(pressedAt: number, myGen: number): Promise<void> {
    // precondition: recState === 'starting', activeKind set, gen === myGen.
    let resolved: Awaited<ReturnType<typeof resolveModeAtPress>>;
    try {
      resolved = await resolveModeAtPress();
    } catch {
      if (gen === myGen) resetState();
      return;
    }
    if (gen !== myGen) return; // superseded (cancel / newer press) during lookup
    const { mode, activeWindow } = resolved;
    if (!mode) {
      console.warn("[Verbatim AI] no modes available — sign in / hydrate first.");
      if (gen === myGen) resetState();
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
    preloadWhisperIfNeeded(mode);
    try {
      await startRecording(mode.name, mode.id, pressedAt);
    } catch (e) {
      // Only tear down if we're still the active session. A superseded start
      // (cancel or a newer press bumped `gen`) must NOT reset newer state or
      // stop a newer recording — the current `gen` owner manages the overlay.
      if (gen === myGen) {
        resetState();
        // startRecording may have emitted `recording:start` before failing;
        // stop defensively so the overlay/mic never strands.
        try {
          await stopRecording();
        } catch {
          /* ignore */
        }
      }
      console.error("[Verbatim AI] start failed", e);
      return;
    }
    // Cancel (Escape) or a newer press superseded us mid-startup. The owner
    // of the current `gen` handles the overlay; don't touch shared state.
    if (gen !== myGen) return;
    if (pendingStop) {
      // A release (hold) or net toggle-off arrived during startup.
      pendingStop = false;
      recState = "stopping";
      try {
        await stopRecording();
      } finally {
        if (gen === myGen) resetState();
      }
    } else {
      recState = "recording";
    }
  }

  async function stopFlow(myGen: number): Promise<void> {
    recState = "stopping";
    try {
      await stopRecording();
    } finally {
      if (gen === myGen) resetState();
    }
  }

  const offDown = await listen("hotkey:down", () => {
    if (isHotkeyPaused()) return;
    if (!isOnboardingComplete()) return;
    const pressedAt = Date.now();
    if (recState === "idle") {
      // Fresh session — choose hold vs toggle from the *current* config.
      const kind = usesHoldToTalk(loadHotkeyConfig()) ? "hold" : "toggle";
      gen += 1;
      recState = "starting";
      activeKind = kind;
      pendingStop = false;
      void startFlow(pressedAt, gen);
      return;
    }
    // A session is active/in-flight — act on ITS kind, not current config.
    if (activeKind === "toggle") {
      if (recState === "recording") {
        void stopFlow(gen); // toggle-off
      } else if (recState === "starting") {
        pendingStop = !pendingStop; // converge to the latest toggle intent
      }
      // stopping: already tearing down — ignore.
    }
    // activeKind === "hold": extra downs (auto-repeat / re-press) are ignored.
  });

  const offUp = await listen("hotkey:up", () => {
    if (isHotkeyPaused()) return;
    // Only hold sessions stop on release — decide from the session's captured
    // kind, NOT current config (which can change while a key is held).
    if (activeKind !== "hold") return;
    if (recState === "recording") {
      void stopFlow(gen);
    } else if (recState === "starting") {
      // Released before startup resolved — stop as soon as it does.
      pendingStop = true;
    }
  });

  // Global Escape (armed by the recording bridge only while recording)
  // discards the in-progress dictation: no audio saved, overlay hidden,
  // nothing pasted. Reset the state machine so the next hotkey press
  // starts fresh regardless of toggle/hold mode.
  const offCancel = await listen("hotkey:cancel", async () => {
    gen += 1; // invalidate any in-flight startup so it can't resurrect state
    resetState();
    await cancelRecording();
  });

  return () => {
    offDown();
    offUp();
    offCancel();
  };
}
