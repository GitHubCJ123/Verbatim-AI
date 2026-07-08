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
const LS_SILENCE_TRIM = "sw.vad.silenceTrim";
const LS_AUTO_STOP = "sw.vad.autoStop";
const LS_FILLER_FILTER = "sw.postproc.fillerFilter";
const LS_FUZZY_VOCAB = "sw.postproc.fuzzyVocab";
const LS_LIVE_PARTIAL = "sw.transcribe.livePartial";

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
    case "7":
      return 7;
    case "30":
      return 30;
    case "90":
      return 90;
    default:
      return null;
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

/**
 * Post-hoc VAD silence trimming (docs/proposals/handy-adoption.md
 * §Phase 4a). Trims leading/trailing silence from the captured clip
 * before transcription. **Default on** — the trim logic fails open and
 * never cuts speech, so it's a safe latency/quality win.
 */
export function isSilenceTrimEnabled(): boolean {
  return localStorage.getItem(LS_SILENCE_TRIM) !== "0";
}

export function setSilenceTrimEnabled(v: boolean): void {
  localStorage.setItem(LS_SILENCE_TRIM, v ? "1" : "0");
}

/**
 * Hands-free auto-stop (docs/proposals/handy-adoption.md §Phase 4b):
 * end the recording after a hangover of silence using the real-time
 * frame path. **Default off** to preserve push-to-talk / toggle
 * behavior.
 */
export function isAutoStopEnabled(): boolean {
  return localStorage.getItem(LS_AUTO_STOP) === "1";
}

export function setAutoStopEnabled(v: boolean): void {
  localStorage.setItem(LS_AUTO_STOP, v ? "1" : "0");
}

/**
 * Live partial (chunked pseudo-streaming) transcription
 * (docs/proposals/handy-adoption.md §Phase 6, issue #23 P2.6). While
 * recording, the accumulated real-time frames are re-transcribed on VAD
 * segment boundaries / every ~1.75 s and shown as a LIVE partial in the
 * overlay; the final full-quality transcription on stop replaces it.
 *
 * **Default off** — the local engines are request/response (no native
 * token streaming), so this is a best-effort preview that adds repeated
 * transcribe calls. Leaving it off keeps the existing
 * stop→transcribe→postprocess pipeline byte-for-byte unchanged.
 */
export function isLivePartialEnabled(): boolean {
  return localStorage.getItem(LS_LIVE_PARTIAL) === "1";
}

export function setLivePartialEnabled(v: boolean): void {
  localStorage.setItem(LS_LIVE_PARTIAL, v ? "1" : "0");
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

// ─── Inline post-processing (P2.9) ────────────────────────────────────────

/**
 * Whether the filler-word filter is active.
 * Default: false (off) — conservative; the user must opt in.
 */
export function isFillerFilterEnabled(): boolean {
  return localStorage.getItem(LS_FILLER_FILTER) === "1";
}

export function setFillerFilterEnabled(v: boolean): void {
  localStorage.setItem(LS_FILLER_FILTER, v ? "1" : "0");
}

/**
 * Whether fuzzy vocabulary correction is active.
 * Default: false (off) — conservative; the user must opt in.
 */
export function isFuzzyVocabEnabled(): boolean {
  return localStorage.getItem(LS_FUZZY_VOCAB) === "1";
}

export function setFuzzyVocabEnabled(v: boolean): void {
  localStorage.setItem(LS_FUZZY_VOCAB, v ? "1" : "0");
}
