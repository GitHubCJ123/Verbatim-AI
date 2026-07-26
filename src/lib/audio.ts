/**
 * Audio capture pipeline.
 *
 * - Uses `getUserMedia` for the mic, `MediaRecorder` for encoding,
 *   and a parallel `AnalyserNode` for live waveform RMS data.
 * - Returns a controller that exposes `stop()` and a `level` reader
 *   that callers can poll from `requestAnimationFrame`.
 *
 * Spec: plan §12 (Audio Pipeline).
 */
import { isPerfDebugEnabled, isNativeCaptureEnabled } from "./preferences";

export interface AudioControllerOptions {
  deviceId?: string;
  /** Called when the user clicks "Allow" and capture is live. */
  onStart?: () => void;
  /** Called if anything blows up. */
  onError?: (err: Error) => void;
  /**
   * Real-time frame sink (docs/proposals/handy-adoption.md §Phase 3).
   * When provided, an AudioWorklet emits 16 kHz mono Float32 frames
   * (~30 ms / 480 samples) *during* recording, unblocking VAD auto-stop.
   * Omitting it keeps the lighter default path (no worklet) untouched.
   */
  onFrame?: (frame: Float32Array) => void;
}

/** URL of the static AudioWorklet module (served from `public/`). */
const PCM_WORKLET_URL = "/worklets/pcm-frame-processor.js";

/**
 * Ensure the PCM frame worklet module is registered on `ctx` exactly
 * once — re-registering the same processor name throws. The flag lives
 * on the context so a reused keep-warm context skips re-adding.
 */
async function ensurePcmWorklet(ctx: AudioContext): Promise<void> {
  const marked = ctx as AudioContext & { __pcmWorkletLoaded?: Promise<void> };
  if (!marked.__pcmWorkletLoaded) {
    marked.__pcmWorkletLoaded = ctx.audioWorklet.addModule(PCM_WORKLET_URL);
  }
  await marked.__pcmWorkletLoaded;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface AudioController {
  /** Latest amplitude in [0,1], smoothed. Updated continuously while recording. */
  getLevel: () => number;
  /** Latest per-bar amplitude array, length = bars (default 32), values in [0,1]. */
  getBars: (bars?: number) => number[];
  /**
   * Number of real-time PCM frames emitted so far (Phase 3 perf check).
   * Always 0 when no `onFrame` sink was provided.
   */
  getFrameCount: () => number;
  /** Stop recording and return the final encoded blob. Null if cancelled. */
  stop: () => Promise<RecordingResult | null>;
  /** Hard-abort: stop the recorder and discard any final blob. */
  cancel: () => void;
}

/**
 * Keep-warm mic cache (docs/improvement-plan/04-performance-latency.md,
 * Fix 2). Acquiring a MediaStream cold costs 300–1000 ms — the dominant
 * chunk of hotkey→listening latency. After a recording ends we park the
 * stream + AudioContext for a short window and reuse them if the next
 * dictation starts soon after, making back-to-back dictations instant.
 * Trade-off: the OS mic-in-use indicator stays on for the window.
 */
const KEEP_WARM_MS = 30_000;

interface WarmMic {
  stream: MediaStream;
  ctx: AudioContext;
  /** Device key the stream was opened with ("" = system default). */
  deviceKey: string;
  timer: ReturnType<typeof setTimeout>;
}

let warm: WarmMic | null = null;

function discardWarm() {
  if (!warm) return;
  clearTimeout(warm.timer);
  warm.stream.getTracks().forEach((t) => t.stop());
  void warm.ctx.close().catch(() => {});
  warm = null;
}

function takeWarm(deviceKey: string): { stream: MediaStream; ctx: AudioContext } | null {
  if (!warm) return null;
  const usable =
    warm.deviceKey === deviceKey &&
    warm.stream.getAudioTracks().some((t) => t.readyState === "live");
  if (!usable) {
    discardWarm();
    return null;
  }
  clearTimeout(warm.timer);
  const { stream, ctx } = warm;
  warm = null;
  return { stream, ctx };
}

function parkWarm(stream: MediaStream, ctx: AudioContext, deviceKey: string) {
  discardWarm();
  if (!stream.getAudioTracks().some((t) => t.readyState === "live")) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
    return;
  }
  warm = {
    stream,
    ctx,
    deviceKey,
    timer: setTimeout(discardWarm, KEEP_WARM_MS),
  };
}

/** Stop the cached mic immediately (OS indicator turns off). */
export function releaseWarmMic() {
  discardWarm();
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/wav",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

/**
 * Adopt a native session Rust's push-to-talk hot path already started
 * (issue #53), instead of arming + starting a new one. Unlike
 * `startRecording`'s native branch, this never falls back to WebAudio on
 * failure — Rust has already committed to a native session, so starting a
 * second (WebAudio) capture on top of it would double-record instead of
 * recovering. Callers should treat a rejection the same as any other
 * `AudioControllerOptions.onError` — the caller decides how to present it.
 */
export async function adoptNativeRecording(
  sessionId: number,
  opts: AudioControllerOptions = {},
): Promise<AudioController> {
  const { adoptNativeRecording: adopt } = await import("./nativeAudio");
  return adopt(sessionId, opts);
}

export async function startRecording(opts: AudioControllerOptions = {}): Promise<AudioController> {
  // Route 3B (docs/proposals/handy-adoption.md §Phase 3): when opted in, capture
  // in Rust (cpal + rubato) instead of MediaRecorder. Default off keeps the
  // WebAudio path below completely untouched. Dynamically imported so the native
  // module (and its Tauri event listeners) is only loaded when enabled.
  if (isNativeCaptureEnabled()) {
    try {
      const { startNativeRecording } = await import("./nativeAudio");
      // Suppress the native onError here so a fallback isn't surfaced as a
      // failure; the WebAudio path below reports its own errors.
      return await startNativeRecording({ ...opts, onError: undefined });
    } catch (e) {
      // Native capture is default-on ("Fast") but newer; if it can't arm/start
      // (device, permission, or driver issue) fall back to the proven WebAudio
      // path so recording always works.
      console.warn(
        "[Verbatim AI] native capture failed to start; falling back to WebAudio.",
        e,
      );
    }
  }

  const requestedKey = opts.deviceId ?? "";
  let usedKey = requestedKey;
  let stream: MediaStream;
  let audioCtx: AudioContext;

  const acquireStart = performance.now();
  const warmHit = takeWarm(requestedKey);
  if (warmHit) {
    ({ stream, ctx: audioCtx } = warmHit);
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
  } else {
    const buildAudioConstraints = (deviceId?: string): MediaTrackConstraints => {
      const audio: MediaTrackConstraints = {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (deviceId) audio.deviceId = { exact: deviceId };
      return audio;
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(opts.deviceId),
      });
    } catch (err) {
      if (opts.deviceId) {
        try {
          console.warn("Selected microphone was unavailable; falling back to system default.", err);
          stream = await navigator.mediaDevices.getUserMedia({
            audio: buildAudioConstraints(),
          });
          usedKey = "";
        } catch {
          const e = err instanceof Error ? err : new Error(String(err));
          opts.onError?.(e);
          throw e;
        }
      } else {
        const e = err instanceof Error ? err : new Error(String(err));
        opts.onError?.(e);
        throw e;
      }
    }
    audioCtx = new AudioContext();
  }

  if (isPerfDebugEnabled()) {
    console.info(
      `[perf] mic acquire ${Math.round(performance.now() - acquireStart)}ms (${warmHit ? "warm" : "cold"})`,
    );
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.55;
  analyser.minDecibels = -85;
  analyser.maxDecibels = -15;
  source.connect(analyser);

  // Real-time frame path (Phase 3A). Only wired when a sink is provided,
  // so the default push-to-talk path pays no worklet cost. Everything is
  // best-effort: any failure degrades to "no live frames" and never
  // breaks the MediaRecorder blob path below.
  let workletNode: AudioWorkletNode | null = null;
  let muteGain: GainNode | null = null;
  let frameCount = 0;
  let workletDisposed = false;
  if (opts.onFrame) {
    const sink = opts.onFrame;
    void ensurePcmWorklet(audioCtx)
      .then(() => {
        if (workletDisposed) return;
        const node = new AudioWorkletNode(audioCtx, "pcm-frame-processor");
        node.port.onmessage = (e: MessageEvent) => {
          frameCount++;
          sink(e.data as Float32Array);
        };
        // Route through a muted gain to the destination so the render
        // thread actually pulls the worklet (no audible output).
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        source.connect(node);
        node.connect(gain);
        gain.connect(audioCtx.destination);
        workletNode = node;
        muteGain = gain;
      })
      .catch((err) => {
        if (isPerfDebugEnabled()) {
          console.warn("[perf] PCM worklet unavailable; live frames disabled.", err);
        }
      });
  }

  const freqBuffer = new Uint8Array(analyser.frequencyBinCount);
  const timeBuffer = new Uint8Array(analyser.fftSize);

  // Smoothed amplitude
  let smoothedLevel = 0;
  const smoothing = 0.65;

  const getLevel = () => {
    analyser.getByteTimeDomainData(timeBuffer);
    let sumSq = 0;
    for (let i = 0; i < timeBuffer.length; i++) {
      const v = (timeBuffer[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / timeBuffer.length);
    // Boost low signal so visible motion appears at normal speech levels.
    const boosted = Math.min(1, rms * 3);
    smoothedLevel = smoothing * smoothedLevel + (1 - smoothing) * boosted;
    return smoothedLevel;
  };

  const getBars = (bars = 32) => {
    analyser.getByteFrequencyData(freqBuffer);
    const out = new Array<number>(bars);
    // Focus on speech band (~80 Hz–4 kHz). At sampleRate 16 kHz and
    // fftSize 256, bin width is ~62.5 Hz. Use the first ~64 bins so we
    // skip very high frequencies that don't move with voice.
    const usable = Math.min(64, freqBuffer.length);
    const bucket = Math.max(1, Math.floor(usable / bars));
    for (let b = 0; b < bars; b++) {
      let sum = 0;
      const start = b * bucket;
      const end = Math.min(usable, start + bucket);
      for (let i = start; i < end; i++) sum += freqBuffer[i];
      const avg = sum / (end - start);
      // 0..255 → 0..1 with a soft curve.
      out[b] = Math.min(1, (avg / 255) ** 0.7);
    }
    return out;
  };

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  const startedAt = performance.now();
  let cancelled = false;

  const cleanup = () => {
    // Park instead of tearing down — the next dictation inside the
    // keep-warm window reuses the stream and skips getUserMedia.
    workletDisposed = true;
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch {
        /* already disconnected */
      }
      workletNode = null;
    }
    if (muteGain) {
      try {
        muteGain.disconnect();
      } catch {
        /* already disconnected */
      }
      muteGain = null;
    }
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    parkWarm(stream, audioCtx, usedKey);
  };

  const stop = () =>
    new Promise<RecordingResult | null>((resolve) => {
      if (recorder.state === "inactive") {
        cleanup();
        resolve(null);
        return;
      }
      recorder.addEventListener(
        "stop",
        () => {
          const durationMs = performance.now() - startedAt;
          let result: RecordingResult | null = null;
          if (!cancelled) {
            const finalType = mimeType || "audio/webm";
            const blob = new Blob(chunks, { type: finalType });
            result = { blob, mimeType: finalType, durationMs };
          }
          cleanup();
          resolve(result);
        },
        { once: true },
      );
      recorder.stop();
    });

  const cancel = () => {
    cancelled = true;
    if (recorder.state !== "inactive") recorder.stop();
    cleanup();
  };

  recorder.start();
  opts.onStart?.();

  return { getLevel, getBars, getFrameCount: () => frameCount, stop, cancel };
}
