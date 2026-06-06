/**
 * Lightweight UI preferences kept in localStorage. Things in here are
 * boolean knobs and small enums — they don't need a Zustand store.
 */
import {
  isEnabled as autostartIsEnabled,
  enable as autostartEnable,
  disable as autostartDisable,
} from "@tauri-apps/plugin-autostart";

const LS_OVERLAY_POSITION = "sw.overlay.position";
const LS_MIC_DEVICE = "sw.mic.deviceId";
const LS_HOTKEY_PAUSED = "sw.hotkey.paused";
const LS_CLIPBOARD_RESTORE = "sw.clipboard.restore";
const LS_INSERT_ONLY = "sw.output.insertOnly";
const LS_TELEMETRY = "sw.telemetry.enabled";
const LS_AI_DISABLED = "sw.ai.disabled";
const LS_HISTORY_DISABLED = "sw.history.disabled";

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

export function isClipboardRestoreEnabled(): boolean {
  // Off by default — Windows already keeps clipboard history (Win+V).
  return localStorage.getItem(LS_CLIPBOARD_RESTORE) === "1";
}

export function setClipboardRestore(v: boolean): void {
  localStorage.setItem(LS_CLIPBOARD_RESTORE, v ? "1" : "0");
}

/**
 * Insert-only output. When on, the cleaned transcription is pasted into the
 * focused app but is NOT left on the system clipboard afterwards. Off by
 * default so existing users keep today's copy + paste behavior.
 */
export function isInsertOnlyEnabled(): boolean {
  return localStorage.getItem(LS_INSERT_ONLY) === "1";
}

export function setInsertOnly(v: boolean): void {
  localStorage.setItem(LS_INSERT_ONLY, v ? "1" : "0");
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
