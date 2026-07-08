/**
 * Realtime auto-stop endpointing (docs/proposals/handy-adoption.md
 * §Phase 4b). Consumes the live 16 kHz mono frames emitted by the
 * AudioWorklet (Phase 3) and fires a single `onSilence` callback once a
 * hangover of silence follows detected speech — enabling hands-free
 * endpointing.
 *
 * This is **opt-in** (default off) so it never changes push-to-talk /
 * toggle behavior. All safeguards fail *safe*: it only ever fires after
 * real speech was observed and a minimum recording time has elapsed.
 */
import { SmoothedVad, VAD_FRAME_SAMPLES, VAD_FRAME_MS, type SmoothedVadOptions } from "./vad";

export interface AutoStopOptions extends SmoothedVadOptions {
  /** Fired once when silence endpointing triggers. */
  onSilence: () => void;
  /** Minimum accumulated speech before auto-stop may fire. */
  minSpeechMs?: number;
  /** Minimum wall-clock recording time before auto-stop may fire. */
  minRecordingMs?: number;
  /** Samples per processed frame (defaults to 16 kHz / 30 ms = 480). */
  frameSamples?: number;
}

export class AutoStopDetector {
  private readonly vad: SmoothedVad;
  private readonly onSilence: () => void;
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly minSpeechMs: number;
  private readonly minRecordingMs: number;

  private pending: number[] = [];
  private speechMs = 0;
  private hadSpeech = false;
  private wasSpeech = false;
  private fired = false;
  private readonly startedAt = Date.now();

  constructor(opts: AutoStopOptions) {
    this.vad = new SmoothedVad(opts);
    this.onSilence = opts.onSilence;
    this.frameSamples = opts.frameSamples ?? VAD_FRAME_SAMPLES;
    this.frameMs = opts.frameMs ?? VAD_FRAME_MS;
    this.minSpeechMs = opts.minSpeechMs ?? 300;
    this.minRecordingMs = opts.minRecordingMs ?? 1000;
  }

  /** Feed a live frame (any length; buffered to frame size internally). */
  push(frame: Float32Array): void {
    if (this.fired) return;
    for (let i = 0; i < frame.length; i++) this.pending.push(frame[i]);
    while (this.pending.length >= this.frameSamples) {
      const chunk = Float32Array.from(this.pending.splice(0, this.frameSamples));
      this.consumeFrame(chunk);
      if (this.fired) return;
    }
  }

  private consumeFrame(chunk: Float32Array): void {
    const { isSpeech } = this.vad.process(chunk);
    if (isSpeech) {
      this.speechMs += this.frameMs;
      if (this.speechMs >= this.minSpeechMs) this.hadSpeech = true;
    }

    // Trailing edge: speech -> silence after the hangover elapsed.
    if (this.wasSpeech && !isSpeech && this.hadSpeech) {
      if (Date.now() - this.startedAt >= this.minRecordingMs) {
        this.fired = true;
        this.onSilence();
      }
    }
    this.wasSpeech = isSpeech;
  }

  /** True once auto-stop has fired (idempotent). */
  get hasFired(): boolean {
    return this.fired;
  }

  /** Prevent any further firing (e.g. after a manual stop/cancel). */
  disable(): void {
    this.fired = true;
  }
}
