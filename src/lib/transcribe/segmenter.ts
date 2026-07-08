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
 * On a trigger it hands the accumulated PCM ("audio-so-far") to
 * {@link PartialSegmenterOptions.onPartial}; the overlay routes that to
 * the {@link TranscriptionCoordinator} so overlapping requests are
 * serialized. This is a **chunked pseudo-streaming** design: the batch
 * engines (whisper-cli / whisper-server) are request/response, so true
 * token-level streaming is not possible here — it's a follow-up that
 * needs a streaming-capable engine.
 *
 * The whole feature is opt-in (default off); this class only runs when a
 * frame sink is wired, so the default path pays nothing.
 */
import { SmoothedVad, VAD_FRAME_SAMPLES, VAD_FRAME_MS, type SmoothedVadOptions } from "../vad/vad";

export interface PartialSegmenterOptions extends SmoothedVadOptions {
  /** Called with a copy of the audio-so-far when a partial should run. */
  onPartial: (pcm: Float32Array) => void;
  /** Minimum accumulated audio before the first partial. Default 500 ms. */
  minAudioMs?: number;
  /** Cadence: emit at least this often between partials. Default 1750 ms. */
  intervalMs?: number;
  /** Also emit on VAD speech→silence boundaries. Default true. */
  emitOnBoundary?: boolean;
  /**
   * Hard cap on accumulated audio. Past this, no further partials fire —
   * bounds the O(n) re-transcribe cost / memory of the cumulative buffer
   * for long recordings (the final stop→transcribe path still covers the
   * full clip). Default 30 000 ms.
   */
  maxAudioMs?: number;
  /** Samples per processed frame. Default 16 kHz / 30 ms = 480. */
  frameSamples?: number;
  /** Injectable VAD (tests). Defaults to a fresh {@link SmoothedVad}. */
  vad?: SmoothedVad;
}

export class PartialSegmenter {
  private readonly vad: SmoothedVad;
  private readonly onPartial: (pcm: Float32Array) => void;
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly minAudioMs: number;
  private readonly intervalMs: number;
  private readonly emitOnBoundary: boolean;
  private readonly maxAudioMs: number;

  /** Sub-frame carry buffer for frames that don't align to frameSamples. */
  private carry: number[] = [];
  /** Accumulated audio-so-far. */
  private samples: number[] = [];
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
    // Past the cap: keep endpointing state coherent but stop growing the
    // buffer and never emit again.
    if (this.totalMs >= this.maxAudioMs) {
      this.wasSpeech = this.vad.process(chunk).isSpeech;
      this.totalMs += this.frameMs;
      return;
    }

    for (let i = 0; i < chunk.length; i++) this.samples.push(chunk[i]);
    this.totalMs += this.frameMs;

    const { isSpeech } = this.vad.process(chunk);
    const boundary = this.emitOnBoundary && this.wasSpeech && !isSpeech;
    const cadence = this.totalMs - this.lastEmitMs >= this.intervalMs;
    this.wasSpeech = isSpeech;

    if ((boundary || cadence) && this.totalMs >= this.minAudioMs) {
      this.lastEmitMs = this.totalMs;
      this.onPartial(Float32Array.from(this.samples));
    }
  }
}
