/**
 * Native audio capture path (docs/proposals/handy-adoption.md §Phase 3,
 * route 3B).
 *
 * When the `sw.audio.nativeCapture` flag is on, recording is performed in Rust
 * (`cpal` + `rubato` → 16 kHz mono f32) rather than by the WebView
 * `MediaRecorder`. The Rust `stop_native_capture` command returns the recorded
 * PCM, which we re-package as a WAV `Blob` so the rest of the pipeline — every
 * provider decodes the blob via `decodeToMonoF32_16k` — is untouched.
 *
 * This module exposes an {@link AudioController} that mirrors the shape of the
 * default `startRecording` controller, so the overlay can swap capture backends
 * transparently.
 *
 * Deferred (follow-up): streaming native frames to the `onFrame` sink. The
 * native path does not yet emit per-frame PCM, so VAD auto-stop / live partials
 * (both opt-in, default off) keep relying on the default WebAudio capture.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { encodeWavBlob } from "./audio/wav";
import { VAD_SAMPLE_RATE } from "./vad/vad";
import type { AudioController, AudioControllerOptions, RecordingResult } from "./audio";
import { isPerfDebugEnabled } from "./preferences";

interface LevelEvent {
  rms: number;
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

/**
 * Start native capture. Resolves once the Rust stream is live so callers can
 * treat it like the default `startRecording`.
 */
export async function startNativeRecording(
  opts: AudioControllerOptions = {},
): Promise<AudioController> {
  const deviceName = await resolveDeviceLabel(opts.deviceId);

  // Latest smoothed level, driven by throttled RMS events from Rust.
  let smoothedLevel = 0;
  const smoothing = 0.65;
  let latestRms = 0;

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<LevelEvent>("native_audio:level", (event) => {
      const rms = event.payload?.rms ?? 0;
      // Boost low signal so visible motion appears at normal speech levels.
      latestRms = Math.min(1, rms * 3);
    });
  } catch {
    /* level meter is best-effort; capture still works without it */
  }

  const startedAt = performance.now();
  try {
    await invoke("start_native_capture", { deviceName: deviceName ?? null });
  } catch (err) {
    if (unlisten) unlisten();
    const e = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(e);
    throw e;
  }
  opts.onStart?.();

  let stopped = false;

  const detach = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

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
      const pcmArray = await invoke<number[]>("stop_native_capture");
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
    // Fire-and-forget: stop the native stream and discard the audio.
    void invoke("stop_native_capture").catch(() => {});
    detach();
  };

  return { getLevel, getBars, getFrameCount: () => 0, stop, cancel };
}
