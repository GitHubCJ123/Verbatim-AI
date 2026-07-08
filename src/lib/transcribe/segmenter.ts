/**
 * Partial-transcription segmenter (docs/proposals/handy-adoption.md
 * §Phase 6, issue #23 P2.6).
 *
 * Consumes the live 16 kHz mono frames emitted by the AudioWorklet
 * (Phase 3) during recording and decides *when* to fire a partial
 * transcription of the audio-so-far. Two triggers, whichever comes
 * first, once a minimum of audio exists:
 *   1. a VAD speech→silence boundary (end of an utterance segment), or
 *   2. a fixed cadence (~1.75 s) since the previous partial.
 *
 * On a trigger it hands PCM to {@link PartialSegmenterOptions.onPartial};
 * while the recording is short this is the accumulated audio-so-far. For
 * longer recordings it switches to a bounded rolling window so previews keep
 * moving without unbounded O(n) re-transcribes. The overlay routes requests to
 * the {@link TranscriptionCoordinator} so overlapping requests are serialized.
 * This is still a **chunked pseudo-streaming** design: the batch engines
 * (whisper-cli / whisper-server) are request/response, so true token-level
 * streaming needs a streaming-capable engine.
 *
 * The whole feature is opt-in (default off); this class only runs when a
 * frame sink is wired, so the default path pays nothing.
 */
import { SmoothedVad, VAD_FRAME_SAMPLES, VAD_FRAME_MS, type SmoothedVadOptions } from "../vad/vad";

export interface PartialTranscriptionPayload {
  pcm: Float32Array;
  /** Start offset of this PCM window within the current recording. */
  windowStartMs: number;
  /** End offset of this PCM window within the current recording. */
  totalMs: number;
  /** True while the payload still contains the whole recording-so-far. */
  isFullContext: boolean;
}

export interface PartialSegmenterOptions extends SmoothedVadOptions {
  /** Called with a copy of the current full-context or rolling-window PCM. */
  onPartial: (payload: PartialTranscriptionPayload) => void;
  /** Minimum accumulated audio before the first partial. Default 500 ms. */
  minAudioMs?: number;
  /** Cadence: emit at least this often between partials. Default 1750 ms. */
  intervalMs?: number;
  /** Also emit on VAD speech→silence boundaries. Default true. */
  emitOnBoundary?: boolean;
  /**
   * Full-context cap. Past this, partials switch from "audio-so-far" to a
   * rolling window so long recordings still update while bounding repeated
   * batch-transcribe cost. The final stop→transcribe path still covers the
   * full clip. Default 30 000 ms.
   */
  maxAudioMs?: number;
  /**
   * Rolling window size after maxAudioMs. Large enough to preserve context,
   * small enough to avoid repeatedly transcribing very long clips.
   * Default 12 000 ms.
   */
  rollingWindowMs?: number;
  /** Samples per processed frame. Default 16 kHz / 30 ms = 480. */
  frameSamples?: number;
  /** Injectable VAD (tests). Defaults to a fresh {@link SmoothedVad}. */
  vad?: SmoothedVad;
}

export class PartialSegmenter {
  private readonly vad: SmoothedVad;
  private readonly onPartial: (payload: PartialTranscriptionPayload) => void;
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly minAudioMs: number;
  private readonly intervalMs: number;
  private readonly emitOnBoundary: boolean;
  private readonly maxAudioMs: number;
  private readonly rollingWindowMs: number;
  private readonly sampleRate: number;

  /** Sub-frame carry buffer for frames that don't align to frameSamples. */
  private carry: number[] = [];
  /** Accumulated audio-so-far, or the bounded rolling window after maxAudioMs. */
  private samples: number[] = [];
  /** Recording offset corresponding to samples[0]. */
  private sampleStartMs = 0;
  private totalMs = 0;
  private lastEmitMs = 0;
  private wasSpeech = false;
  private disposed = false;

  constructor(opts: PartialSegmenterOptions) {
    this.vad = opts.vad ?? new SmoothedVad(opts);
    this.onPartial = opts.onPartial;
    this.frameSamples = opts.frameSamples ?? VAD_FRAME_SAMPLES;
    this.frameMs = opts.frameMs ?? VAD_FRAME_MS;
    this.minAudioMs = opts.minAudioMs ?? 500;
    this.intervalMs = opts.intervalMs ?? 1750;
    this.emitOnBoundary = opts.emitOnBoundary ?? true;
    this.maxAudioMs = opts.maxAudioMs ?? 30_000;
    this.rollingWindowMs = opts.rollingWindowMs ?? 12_000;
    this.sampleRate = this.frameSamples / (this.frameMs / 1000);
  }

  /** Feed a live frame (any length; buffered to frame size internally). */
  push(frame: Float32Array): void {
    if (this.disposed) return;
    for (let i = 0; i < frame.length; i++) this.carry.push(frame[i]);
    while (this.carry.length >= this.frameSamples) {
      const chunk = Float32Array.from(this.carry.splice(0, this.frameSamples));
      this.consumeFrame(chunk);
      if (this.disposed) return;
    }
  }

  /** Stop all further processing and emissions. */
  dispose(): void {
    this.disposed = true;
    this.carry = [];
  }

  private consumeFrame(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) this.samples.push(chunk[i]);
    this.totalMs += this.frameMs;
    this.trimRollingWindowIfNeeded();

    const { isSpeech } = this.vad.process(chunk);
    const boundary = this.emitOnBoundary && this.wasSpeech && !isSpeech;
    const cadence = this.totalMs - this.lastEmitMs >= this.intervalMs;
    this.wasSpeech = isSpeech;

    if ((boundary || cadence) && this.totalMs >= this.minAudioMs) {
      this.lastEmitMs = this.totalMs;
      this.onPartial({
        pcm: Float32Array.from(this.samples),
        windowStartMs: Math.round(this.sampleStartMs),
        totalMs: this.totalMs,
        isFullContext: this.sampleStartMs === 0,
      });
    }
  }

  private trimRollingWindowIfNeeded(): void {
    if (this.totalMs <= this.maxAudioMs) return;
    const keepSamples = Math.max(
      this.frameSamples,
      Math.round((this.rollingWindowMs / 1000) * this.sampleRate),
    );
    const excess = this.samples.length - keepSamples;
    if (excess <= 0) return;
    this.samples.splice(0, excess);
    this.sampleStartMs += (excess / this.sampleRate) * 1000;
  }
}
