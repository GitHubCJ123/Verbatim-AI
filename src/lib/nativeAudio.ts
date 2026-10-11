/**
 * Native audio capture path (docs/proposals/handy-adoption.md §Phase 3,
 * route 3B).
 *
 * When the `sw.audio.nativeCapture` flag is on, recording is performed in Rust
 * (`cpal` + `rubato` → 16 kHz mono f32) rather than by the WebView
 * `MediaRecorder`. The Rust warm-capture engine keeps a cpal stream armed and
 * recording sessions are consumption markers over that warm stream. On stop,
 * we take the session PCM and re-package it as a WAV `Blob` so the rest of the
 * pipeline — every provider decodes the blob via `decodeToMonoF32_16k` — is
 * untouched.
 *
 * This module exposes an {@link AudioController} that mirrors the shape of the
 * default `startRecording` controller, so the overlay can swap capture backends
 * transparently.
 *
 * Frame streaming (route 3B follow-up, issue #23 / closed #35): when the caller
 * provides an `onFrame` sink, Rust also streams live 16 kHz mono f32 frames
 * (480 samples / ~30 ms, base64-encoded) via `native_audio:frame`. We decode
 * and forward them to the same sink the WebAudio worklet feeds, so VAD
 * silence-trim / auto-stop and live partials work under native capture too.
 * When no `onFrame` sink is provided, `streamFrames` is false and Rust never
 * emits frame events — the path is inert.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { encodeWavBlob } from "./audio/wav";
import { VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from "./vad/vad";
import type { AudioController, AudioControllerOptions, RecordingResult } from "./audio";
import * as preferences from "./preferences";

const LS_MIC_DEVICE = "sw.mic.deviceId";
const LS_NATIVE_CAPTURE = "sw.audio.nativeCapture";
const LS_LOW_LATENCY_MODE = "sw.audio.lowLatencyMode";
const LS_PRE_ROLL_MS = "sw.audio.preRollMs";
const DEFAULT_PRE_ROLL_MS = 250;
const MAX_PRE_ROLL_MS = 500;

interface LevelEvent {
  sessionId: number;
  rms: number;
}

interface FrameEvent {
  sessionId: number;
  /** Base64 of `VAD_FRAME_SAMPLES` little-endian f32 samples. */
  data: string;
}

/** Sanitized mid-session capture failure (issue #53, S2). Never contains
 * paths, device unique ids, transcripts, or raw audio — see
 * `native_audio.rs`'s `sanitize_stream_error_message`. */
interface NativeErrorEvent {
  sessionId?: number;
  code: string;
  message: string;
  recoverable?: boolean;
}

/**
 * Decode a base64 `native_audio:frame` payload into a 16 kHz mono Float32
 * frame. Bytes are little-endian f32 (matching Rust `f32::to_le_bytes`); we
 * read them explicitly little-endian so the result is correct regardless of
 * host endianness.
 */
export function decodeFrame(data: string): Float32Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * Resolve a WebView `deviceId` (from `sw.mic.deviceId`) to its human-readable
 * device label, which `cpal` can match by name. Returns `undefined` for the
 * system-default selection or when enumeration is unavailable.
 */
async function resolveDeviceLabel(deviceId?: string): Promise<string | undefined> {
  if (!deviceId) return undefined;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const match = devices.find((d) => d.kind === "audioinput" && d.deviceId === deviceId);
    return match?.label || undefined;
  } catch {
    return undefined;
  }
}

function isLowLatencyModeEnabled(): boolean {
  if ("isLowLatencyModeEnabled" in preferences) return preferences.isLowLatencyModeEnabled();
  return storageItem(LS_LOW_LATENCY_MODE) === "1";
}

function getPreRollMs(): number {
  if ("getPreRollMs" in preferences) return preferences.getPreRollMs();
  const raw = storageItem(LS_PRE_ROLL_MS);
  const n = raw === null ? DEFAULT_PRE_ROLL_MS : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PRE_ROLL_MS;
  return Math.min(MAX_PRE_ROLL_MS, Math.max(0, Math.round(n)));
}

function isNativeCaptureEnabled(): boolean {
  if ("isNativeCaptureEnabled" in preferences) return preferences.isNativeCaptureEnabled();
  return storageItem(LS_NATIVE_CAPTURE) === "1";
}

function getStoredMicDeviceId(): string {
  if ("getMicDeviceId" in preferences) return preferences.getMicDeviceId();
  return storageItem(LS_MIC_DEVICE) || "";
}

function storageItem(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function isPerfDebugEnabled(): boolean {
  return "isPerfDebugEnabled" in preferences ? preferences.isPerfDebugEnabled() : false;
}

/**
 * Best-effort boot/settings hook for the warm native capture engine.
 *
 * Low-latency mode keeps the mic persistently warm before the first press;
 * default native capture remains on-demand so the OS mic indicator stays off
 * until recording actually starts.
 *
 * Issue #53: also pushes the Rust-first push-to-talk hot-path config
 * (`configure_native_ptt_hotpath`) so a `fn`/hotkey press can start native
 * capture synchronously in Rust, before any JS runs. Called at boot
 * (`hotkey.ts`) and whenever the recording-engine setting, pre-roll, or mic
 * device changes (`Settings.tsx`) — never at key-down time.
 */
export async function syncNativeCaptureArm(): Promise<void> {
  const enabled = isNativeCaptureEnabled();
  const keepWarm = enabled && isLowLatencyModeEnabled();
  const deviceName = enabled ? await resolveDeviceLabel(getStoredMicDeviceId()) : undefined;

  try {
    await invoke("configure_native_ptt_hotpath", {
      enabled,
      preRollMs: enabled ? getPreRollMs() : 0,
      deviceName: deviceName ?? null,
      keepWarm,
      // The hot path can't yet know whether the resolved mode wants live
      // partials/VAD frames (mode resolution runs after it starts capture),
      // so it always arms with frames off; `adoptNativeRecording` re-arms
      // with the resolved value right after adopting the session.
      streamFrames: false,
    });
  } catch {
    /* best-effort */
  }

  if (!enabled) {
    try {
      await invoke("disarm_native_capture");
    } catch {
      /* best-effort */
    }
    return;
  }

  if (!keepWarm) return;

  try {
    await invoke("arm_native_capture", {
      deviceName: deviceName ?? null,
      keepWarm: true,
      streamFrames: false,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Shared controller machinery for both native start paths below. Registers
 * level/frame/error listeners *before* awaiting `resolveSession` (which
 * either arms + starts a brand new session — `startNativeRecording` — or is
 * already resolved by Rust — `adoptNativeRecording`, issue #53) so a fast
 * event during any async round-trip can't be missed. On a resolve failure,
 * listeners are torn down and the error surfaces via `opts.onError` before
 * rethrowing, exactly as `startNativeRecording` did previously.
 */
async function attachNativeController(
  opts: AudioControllerOptions,
  resolveSession: () => Promise<{ sessionId: number; legacyCapture: boolean }>,
): Promise<AudioController> {
  const startedAt = performance.now();

  // Latest smoothed level, driven by throttled RMS events from Rust.
  let smoothedLevel = 0;
  const smoothing = 0.65;
  let latestRms = 0;
  let stopped = false;
  let frameCount = 0;
  let sessionId = 0;
  let legacyCapture = false;

  let unlisten: UnlistenFn | null = null;
  let frameUnlisten: UnlistenFn | null = null;
  let errorUnlisten: UnlistenFn | null = null;
  const detach = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (frameUnlisten) {
      frameUnlisten();
      frameUnlisten = null;
    }
    if (errorUnlisten) {
      errorUnlisten();
      errorUnlisten = null;
    }
  };

  try {
    unlisten = await listen<LevelEvent>("native_audio:level", (event) => {
      if (!legacyCapture && event.payload?.sessionId !== sessionId) return;
      const rms = event.payload?.rms ?? 0;
      // Boost low signal so visible motion appears at normal speech levels.
      latestRms = Math.min(1, rms * 3);
    });
  } catch {
    /* level meter is best-effort; capture still works without it */
  }

  // Per-frame streaming (VAD / live-partial parity). Only wired when a sink is
  // provided; Rust is told via `streamFrames` so it never emits otherwise.
  if (opts.onFrame) {
    const sink = opts.onFrame;
    try {
      frameUnlisten = await listen<FrameEvent>("native_audio:frame", (event) => {
        if (!legacyCapture && event.payload?.sessionId !== sessionId) return;
        const data = event.payload?.data;
        if (!data) return;
        const frame = decodeFrame(data);
        // Guard against a malformed payload before handing frames to VAD.
        if (frame.length !== VAD_FRAME_SAMPLES) return;
        frameCount++;
        sink(frame);
      });
    } catch {
      /* live frames are best-effort; final-PCM transcription still works */
    }
  }

  // Mid-session device loss / stream failure (issue #53, S2). Treated like a
  // start failure — stop the controller and surface it through the same
  // `onError` the caller already handles — instead of letting a later
  // stop() silently return truncated/empty audio dressed up as success.
  try {
    errorUnlisten = await listen<NativeErrorEvent>("native_audio:error", (event) => {
      if (!legacyCapture && event.payload?.sessionId !== sessionId) return;
      if (stopped) return;
      stopped = true;
      detach();
      opts.onError?.(new Error(event.payload?.message || "native audio capture failed"));
    });
  } catch {
    /* best-effort: a mid-session failure would otherwise only surface as a
       truncated/empty result from a subsequent stop() */
  }

  try {
    const resolved = await resolveSession();
    sessionId = resolved.sessionId;
    legacyCapture = resolved.legacyCapture;
  } catch (err) {
    detach();
    const e = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(e);
    throw e;
  }
  opts.onStart?.();

  const getLevel = () => {
    smoothedLevel = smoothing * smoothedLevel + (1 - smoothing) * latestRms;
    return smoothedLevel;
  };

  // Native capture doesn't expose a spectrum; approximate bars from the current
  // amplitude with a gentle falloff so the meter still animates.
  const getBars = (bars = 32) => {
    const level = getLevel();
    const out = new Array<number>(bars);
    for (let b = 0; b < bars; b++) {
      const falloff = 1 - Math.abs(b - bars / 2) / (bars / 2);
      out[b] = Math.min(1, level * (0.4 + 0.6 * falloff));
    }
    return out;
  };

  const stop = async (): Promise<RecordingResult | null> => {
    if (stopped) return null;
    stopped = true;
    try {
      const pcmArray = legacyCapture
        ? await invoke<number[]>("stop_native_capture")
        : await (async () => {
            await invoke("stop_native_session", { sessionId });
            return invoke<number[]>("take_native_recording", { sessionId });
          })();
      const pcm = Float32Array.from(pcmArray);
      const durationMs = (pcm.length / VAD_SAMPLE_RATE) * 1000;
      if (isPerfDebugEnabled()) {
        console.info(
          `[perf] native capture stop: ${pcm.length} samples (${Math.round(durationMs)}ms), ` +
            `wall ${Math.round(performance.now() - startedAt)}ms`,
        );
      }
      if (pcm.length === 0) return null;
      const blob = encodeWavBlob(pcm, VAD_SAMPLE_RATE);
      return { blob, mimeType: "audio/wav", durationMs };
    } finally {
      detach();
    }
  };

  const cancel = () => {
    if (stopped) {
      detach();
      return;
    }
    stopped = true;
    // Fire-and-forget: stop this session and discard its buffered audio.
    if (legacyCapture) {
      void invoke("stop_native_capture").catch(() => {});
    } else {
      void invoke("stop_native_session", { sessionId }).catch(() => {});
      void invoke("cancel_native_session", { sessionId }).catch(() => {});
    }
    detach();
  };

  return { getLevel, getBars, getFrameCount: () => frameCount, stop, cancel };
}

/**
 * Start a native recording session over the warm Rust engine. Resolves once
 * Rust has marked the session active so callers can treat it like the default
 * `startRecording`.
 */
export async function startNativeRecording(
  opts: AudioControllerOptions = {},
): Promise<AudioController> {
  return attachNativeController(opts, async () => {
    const deviceName = await resolveDeviceLabel(opts.deviceId);
    const keepWarm = isLowLatencyModeEnabled();
    const preRollMs = keepWarm ? getPreRollMs() : 0;
    const streamFrames = !!opts.onFrame;

    await invoke("arm_native_capture", {
      deviceName: deviceName ?? null,
      keepWarm,
      streamFrames,
    });
    const startedSessionId = await invoke<number>("start_native_session", { preRollMs });
    if (typeof startedSessionId === "number" && Number.isFinite(startedSessionId)) {
      return { sessionId: startedSessionId, legacyCapture: false };
    }
    // Defensive compatibility for stale test/mixed-version IPC mocks only;
    // the Tauri 2 warm engine returns a numeric u64 session id.
    await invoke("start_native_capture", { deviceName: deviceName ?? null, streamFrames });
    return { sessionId: 0, legacyCapture: true };
  });
}

/**
 * Adopt a native session Rust's push-to-talk hot path already started
 * (issue #53) instead of arming + starting a new one — the caller must
 * never also call `startNativeRecording` for this key-down.
 *
 * The hot path arms before mode resolution runs, so it always requests
 * `streamFrames: false` (it can't yet know whether this mode wants live
 * partials / VAD auto-stop). This re-arms with the resolved value right
 * away; `set_stream_frames` wires the frame resampler onto the
 * already-active session retroactively, so live frames start flowing
 * without waiting for a new session.
 */
export async function adoptNativeRecording(
  sessionId: number,
  opts: AudioControllerOptions = {},
): Promise<AudioController> {
  return attachNativeController(opts, async () => {
    try {
      const deviceName = await resolveDeviceLabel(opts.deviceId);
      await invoke("arm_native_capture", {
        deviceName: deviceName ?? null,
        keepWarm: isLowLatencyModeEnabled(),
        streamFrames: !!opts.onFrame,
      });
    } catch {
      /* best-effort: the adopted session still records, just without live
         frames — final-PCM transcription is unaffected either way */
    }
    return { sessionId, legacyCapture: false };
  });
}
