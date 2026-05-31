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

export interface AudioControllerOptions {
  deviceId?: string;
  /** Called when the user clicks "Allow" and capture is live. */
  onStart?: () => void;
  /** Called if anything blows up. */
  onError?: (err: Error) => void;
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
  /** Stop recording and return the final encoded blob. Null if cancelled. */
  stop: () => Promise<RecordingResult | null>;
  /** Hard-abort: stop the recorder and discard any final blob. */
  cancel: () => void;
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

export async function startRecording(opts: AudioControllerOptions = {}): Promise<AudioController> {
  let stream: MediaStream;
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

  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.55;
  analyser.minDecibels = -85;
  analyser.maxDecibels = -15;
  source.connect(analyser);

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
    stream.getTracks().forEach((t) => t.stop());
    void audioCtx.close().catch(() => {});
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

  return { getLevel, getBars, stop, cancel };
}
