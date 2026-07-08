/**
 * Lightweight UI preferences kept in localStorage. Things in here are
 * boolean knobs and small enums — they don't need a Zustand store.
 */
import {
  isEnabled as autostartIsEnabled,
  enable as autostartEnable,
  disable as autostartDisable,
} from "@tauri-apps/plugin-autostart";
import { normalizePasteMethod, type PasteMethod } from "./pasteMethod";

const LS_OVERLAY_POSITION = "sw.overlay.position";
const LS_MIC_DEVICE = "sw.mic.deviceId";
const LS_HOTKEY_PAUSED = "sw.hotkey.paused";
const LS_CLIPBOARD_RESTORE = "sw.clipboard.restore";
const LS_OUTPUT_BEHAVIOR = "sw.output.behavior";
const LS_OUTPUT_INSERT_ONLY = "sw.output.insertOnly";
const LS_PASTE_METHOD = "sw.paste.method";
const LS_TELEMETRY = "sw.telemetry.enabled";
const LS_AI_DISABLED = "sw.ai.disabled";
const LS_HISTORY_DISABLED = "sw.history.disabled";
const LS_HISTORY_RETENTION = "sw.history.retentionDays";
const LS_PERF_DEBUG = "sw.debug.perf";

export type OverlayPosition =
  | "bottom-center"
  | "top-center"
  | "bottom-right"
  | "top-right"
  | "bottom-left"
  | "top-left";

export interface AppPreferences {
  overlayPosition: OverlayPosition;
}

export function loadPreferences(): AppPreferences {
  return {
    overlayPosition: loadOverlayPosition(),
  };
}

export function loadOverlayPosition(): OverlayPosition {
  const v = localStorage.getItem(LS_OVERLAY_POSITION);
  switch (v) {
    case "top-center":
    case "bottom-right":
    case "top-right":
    case "bottom-left":
    case "top-left":
    case "bottom-center":
      return v;
    default:
      return "bottom-center";
  }
}

export function setOverlayPosition(v: OverlayPosition): void {
  localStorage.setItem(LS_OVERLAY_POSITION, v);
}

/**
 * Preferred microphone deviceId. Empty string means "system default" —
 * we omit the constraint so the browser picks the default device.
 * Stored in localStorage, which is shared across the main and overlay
 * windows (same webview origin), so the overlay can read it at capture
 * time.
 */
export function getMicDeviceId(): string {
  return localStorage.getItem(LS_MIC_DEVICE) || "";
}

export function setMicDeviceId(v: string): void {
  if (v) localStorage.setItem(LS_MIC_DEVICE, v);
  else localStorage.removeItem(LS_MIC_DEVICE);
}

export function isHotkeyPaused(): boolean {
  return localStorage.getItem(LS_HOTKEY_PAUSED) === "1";
}

export function setHotkeyPaused(v: boolean): void {
  localStorage.setItem(LS_HOTKEY_PAUSED, v ? "1" : "0");
}

export function isAiImproveDisabled(): boolean {
  return localStorage.getItem(LS_AI_DISABLED) === "1";
}

export function setAiImproveDisabled(v: boolean): void {
  localStorage.setItem(LS_AI_DISABLED, v ? "1" : "0");
}

export function isHistoryDisabled(): boolean {
  return localStorage.getItem(LS_HISTORY_DISABLED) === "1";
}

export function setHistoryDisabled(v: boolean): void {
  localStorage.setItem(LS_HISTORY_DISABLED, v ? "1" : "0");
}

/** How long transcripts are kept. null = forever (default). */
export type HistoryRetentionDays = 7 | 30 | 90 | null;

export function getHistoryRetentionDays(): HistoryRetentionDays {
  switch (localStorage.getItem(LS_HISTORY_RETENTION)) {
    case "7": return 7;
    case "30": return 30;
    case "90": return 90;
    default: return null;
  }
}

export function setHistoryRetentionDays(days: HistoryRetentionDays): void {
  if (days === null) localStorage.removeItem(LS_HISTORY_RETENTION);
  else localStorage.setItem(LS_HISTORY_RETENTION, String(days));
}

/**
 * Hot-path latency logging (docs/improvement-plan/04-performance-latency.md,
 * "Measure, don't guess"). Off unless `sw.debug.perf` is "1" — set it
 * from devtools to get press→listening and mic-acquire timings.
 */
export function isPerfDebugEnabled(): boolean {
  return localStorage.getItem(LS_PERF_DEBUG) === "1";
}

export function isClipboardRestoreEnabled(): boolean {
  return getOutputBehavior() === "restore";
}

export function setClipboardRestore(v: boolean): void {
  setOutputBehavior(v ? "restore" : "copy");
}

export type OutputBehavior = "copy" | "insert-only" | "restore";

const OUTPUT_BEHAVIORS: OutputBehavior[] = ["copy", "insert-only", "restore"];

/**
 * How dictated text interacts with the clipboard after transcription:
 * - copy: paste via clipboard and leave dictated text copied.
 * - insert-only: type directly into the target app; clipboard unchanged.
 * - restore: paste via clipboard, then restore the previous clipboard text.
 *
 * Legacy booleans are migrated lazily. If both old knobs are set, choose
 * insert-only because it has the stricter privacy behavior.
 */
export function getOutputBehavior(): OutputBehavior {
  const current = localStorage.getItem(LS_OUTPUT_BEHAVIOR);
  if (OUTPUT_BEHAVIORS.includes(current as OutputBehavior)) {
    return current as OutputBehavior;
  }

  const migrated: OutputBehavior =
    localStorage.getItem(LS_OUTPUT_INSERT_ONLY) === "1"
      ? "insert-only"
      : localStorage.getItem(LS_CLIPBOARD_RESTORE) === "1"
        ? "restore"
        : "copy";
  setOutputBehavior(migrated);
  return migrated;
}

export function setOutputBehavior(v: OutputBehavior): void {
  localStorage.setItem(LS_OUTPUT_BEHAVIOR, v);
  localStorage.setItem(LS_OUTPUT_INSERT_ONLY, v === "insert-only" ? "1" : "0");
  localStorage.setItem(LS_CLIPBOARD_RESTORE, v === "restore" ? "1" : "0");
}

export type { PasteMethod };

export function getPasteMethod(): PasteMethod {
  return normalizePasteMethod(localStorage.getItem(LS_PASTE_METHOD));
}

export function setPasteMethod(v: PasteMethod): void {
  localStorage.setItem(LS_PASTE_METHOD, v);
}

/**
 * Compatibility wrapper for older callers and migrated localStorage keys.
 */
export function isInsertOnlyEnabled(): boolean {
  return getOutputBehavior() === "insert-only";
}

export function setInsertOnly(v: boolean): void {
  setOutputBehavior(v ? "insert-only" : "copy");
}

export function isTelemetryEnabled(): boolean {
  return localStorage.getItem(LS_TELEMETRY) === "1";
}

export function setTelemetryEnabled(v: boolean): void {
  localStorage.setItem(LS_TELEMETRY, v ? "1" : "0");
}

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    return await autostartIsEnabled();
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (enabled) await autostartEnable();
  else await autostartDisable();
}
