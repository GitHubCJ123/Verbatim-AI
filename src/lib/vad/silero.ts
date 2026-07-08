/**
 * Silero-ONNX voice-activity detection (issue #34).
 *
 * A clean-room JS adapter that runs the Silero VAD v5 ONNX network as a
 * {@link FrameVad} frame classifier, so it can be dropped into the
 * existing onset/hangover {@link SmoothedVad} smoothing and the
 * trim/autoStop consumers without touching them.
 *
 * The model, its I/O contract and the ONNX runtime live behind the
 * {@link SileroSession} interface (implemented by `sileroLoader.ts`).
 * This file has **no dependency on onnxruntime-web** so it stays fully
 * unit-testable in Node with a mocked session and never pulls the WASM
 * runtime into non-browser code paths.
 *
 * ── The sync/async bridge ──────────────────────────────────────────
 * ONNX inference is asynchronous, but {@link FrameVad.speechProbability}
 * is synchronous. Two usage shapes are supported:
 *
 *  - **Realtime** (auto-stop): `speechProbability(frame)` buffers the
 *    frame, kicks a fire-and-forget inference pass and returns the most
 *    recent completed probability. Inference for one 512-sample window
 *    (~32 ms) comfortably finishes before the next ~30 ms frame arrives,
 *    so the decision lags by at most one window — negligible against the
 *    450 ms hangover.
 *
 *  - **Post-hoc** (silence trim): {@link precomputeVad} awaits every
 *    window to completion over an already-captured buffer and returns a
 *    {@link PrecomputedVad} that replays the exact per-frame
 *    probabilities synchronously, so `trimSilence` sees real Silero
 *    scores with no interface change.
 */
import { toFrames, type FrameVad } from "./vad";

/** Silero v5 window size at 16 kHz (samples). */
export const SILERO_WINDOW_SAMPLES = 512;
/** Silero v5 LSTM state tensor element count (shape [2, 1, 128]). */
export const SILERO_STATE_SIZE = 2 * 1 * 128;
/** Sample rate the bundled Silero model is trained for. */
export const SILERO_SAMPLE_RATE = 16000;

/** Result of one Silero inference over a single window. */
export interface SileroInferResult {
  /** Speech probability in [0, 1]. */
  probability: number;
  /** Next LSTM state (length {@link SILERO_STATE_SIZE}). */
  state: Float32Array;
}

/**
 * Minimal semantic wrapper around an ONNX Silero session. Kept
 * deliberately narrow (no ONNX types) so it can be trivially mocked in
 * tests and so this module never imports onnxruntime-web.
 */
export interface SileroSession {
  /**
   * Run the model over one {@link SILERO_WINDOW_SAMPLES}-sample window,
   * threading `state` through the LSTM. Returns the speech probability
   * and the next state.
   */
  infer(window: Float32Array, state: Float32Array, sampleRate: number): Promise<SileroInferResult>;
}

/**
 * Silero VAD frame classifier. Buffers incoming frames into fixed
 * 512-sample windows, threads the LSTM state between windows, and resets
 * that state on {@link reset} (between recordings) so one clip can never
 * bleed into the next.
 */
export class SileroVad implements FrameVad {
  private readonly session: SileroSession;
  private readonly sampleRate: number;
  private pending: number[] = [];
  private state = new Float32Array(SILERO_STATE_SIZE);
  private lastProbability = 0;
  private draining: Promise<void> | null = null;
  private epoch = 0;

  constructor(session: SileroSession, sampleRate = SILERO_SAMPLE_RATE) {
    this.session = session;
    this.sampleRate = sampleRate;
  }

  reset(): void {
    // Bump the epoch so any in-flight drain loop (suspended on an async
    // inference started before this reset) discards its result instead of
    // clobbering the freshly-zeroed state — preventing cross-recording
    // bleed even if reset() lands mid-inference.
    this.epoch++;
    this.pending = [];
    this.state = new Float32Array(SILERO_STATE_SIZE);
    this.lastProbability = 0;
    this.draining = null;
  }

  /**
   * Realtime path: buffer the frame, trigger a fire-and-forget inference
   * pass, and return the latest completed probability (see file header).
   */
  speechProbability(frame: Float32Array): number {
    this.enqueue(frame);
    void this.drain();
    return this.lastProbability;
  }

  /**
   * Post-hoc path: buffer the frame and await all ready windows so the
   * returned probability reflects this frame's contribution.
   */
  async speechProbabilityAsync(frame: Float32Array): Promise<number> {
    this.enqueue(frame);
    await this.drain();
    return this.lastProbability;
  }

  private enqueue(frame: Float32Array): void {
    for (let i = 0; i < frame.length; i++) this.pending.push(frame[i]);
  }

  /**
   * Consume every buffered full window. A single drain loop runs at a
   * time; concurrent callers await the in-flight loop, which keeps
   * consuming windows (including newly enqueued ones) until fewer than
   * one window's worth of samples remain.
   */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const epoch = this.epoch;
    const loop = (async () => {
      while (this.pending.length >= SILERO_WINDOW_SAMPLES) {
        const window = Float32Array.from(this.pending.splice(0, SILERO_WINDOW_SAMPLES));
        const { probability, state } = await this.session.infer(
          window,
          this.state,
          this.sampleRate,
        );
        // A reset() during this inference bumps the epoch; discard the
        // now-stale result rather than overwriting the new recording.
        if (epoch !== this.epoch) return;
        this.state = state;
        this.lastProbability = probability;
      }
    })();
    // Clear the in-flight guard on a microtask *after* it is assigned, so
    // a synchronously-completing loop (no full window yet) can't leave a
    // stale resolved promise that would block later drains. If frames
    // arrived while a drain was in flight (or its guard was still set),
    // kick another pass so no full window is left unprocessed.
    this.draining = loop.finally(() => {
      // If a reset() superseded this loop, leave the (possibly new) guard
      // and buffer alone — the post-reset drain owns them now.
      if (epoch !== this.epoch) return;
      this.draining = null;
      if (this.pending.length >= SILERO_WINDOW_SAMPLES) void this.drain();
    });
    return this.draining;
  }
}

/**
 * A {@link FrameVad} that replays a precomputed sequence of per-frame
 * probabilities in order — one probability is returned per call,
 * ignoring the frame argument. Used to feed real Silero scores into the
 * synchronous {@link SmoothedVad}/`trimSilence` loop.
 */
export class PrecomputedVad implements FrameVad {
  private readonly probabilities: ArrayLike<number>;
  private index = 0;

  constructor(probabilities: ArrayLike<number>) {
    this.probabilities = probabilities;
  }

  reset(): void {
    this.index = 0;
  }

  speechProbability(_frame: Float32Array): number {
    if (this.index >= this.probabilities.length) return 0;
    return this.probabilities[this.index++];
  }
}

/**
 * Run Silero over an entire captured buffer and return a
 * {@link PrecomputedVad} replaying one probability per 480-sample frame
 * (the frame grid used by {@link toFrames}/`trimSilence`). The session's
 * LSTM state is reset first so results are independent of prior clips.
 */
export async function precomputeVad(
  pcm: Float32Array,
  vad: SileroVad,
  frameSamples?: number,
): Promise<PrecomputedVad> {
  vad.reset();
  const frames = toFrames(pcm, frameSamples);
  const probabilities = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    probabilities[i] = await vad.speechProbabilityAsync(frames[i]);
  }
  return new PrecomputedVad(probabilities);
}
