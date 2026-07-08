/**
 * Voice-activity detection (VAD) engine.
 *
 * Reimplements the *shape* of Handy's `SmoothedVad`
 * (docs/proposals/handy-adoption.md §Phase 4) — a per-frame speech
 * classifier wrapped in an onset/hangover smoothing state machine with
 * the same conceptual parameters (prefill 450 ms, onset 60 ms, hangover
 * 450 ms).
 *
 * The frame classifier here is a conservative *energy* model with an
 * adaptive noise floor rather than the Silero ONNX network. This keeps
 * the build dependency-free and fully unit-testable in Node. The model
 * sits behind the {@link FrameVad} interface so a Silero ONNX backend
 * can be dropped in later without touching the smoothing/trim logic —
 * Silero is tracked as a follow-up (see PR notes for issue #23).
 */

/** Canonical VAD sample rate. Frames are expected at this rate. */
export const VAD_SAMPLE_RATE = 16000;
/** Frame duration in milliseconds (~30 ms, Handy-parity). */
export const VAD_FRAME_MS = 30;
/** Samples per frame at {@link VAD_SAMPLE_RATE}. */
export const VAD_FRAME_SAMPLES = Math.round((VAD_SAMPLE_RATE * VAD_FRAME_MS) / 1000); // 480

/** A per-frame speech classifier. Returns a probability in [0, 1]. */
export interface FrameVad {
  /** Probability that `frame` contains speech. `frame` length may vary. */
  speechProbability(frame: Float32Array): number;
  /** Reset any internal adaptive state. */
  reset(): void;
}

/** Root-mean-square amplitude of a frame. */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
  return Math.sqrt(sumSq / frame.length);
}

/** Peak absolute amplitude of a buffer. */
export function peakAbs(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

const EPS = 1e-10;
const toDb = (rms: number) => 20 * Math.log10(rms + EPS);

export interface EnergyVadOptions {
  /**
   * Frames quieter than this (dBFS) are treated as certain silence
   * regardless of the adaptive floor — guards against a floor that has
   * adapted upward during a long clip.
   */
  absSilenceDb?: number;
  /** SNR (dB above the noise floor) at which probability starts rising. */
  onsetLowDb?: number;
  /** SNR (dB above the noise floor) at which probability reaches 1. */
  onsetHighDb?: number;
  /** Fast downward adaptation rate for the noise floor (0..1). */
  floorAttack?: number;
  /** Slow upward adaptation rate for the noise floor (0..1). */
  floorRelease?: number;
}

/**
 * Energy-based frame classifier with an adaptive noise floor.
 *
 * The floor tracks the quietest recent energy quickly (attack) and only
 * rises slowly (release) so sustained speech can't lift the floor up to
 * its own level. Speech probability is a smooth ramp of the frame's SNR
 * above that floor.
 */
export class EnergyVad implements FrameVad {
  private readonly absSilenceDb: number;
  private readonly onsetLowDb: number;
  private readonly onsetHighDb: number;
  private readonly floorAttack: number;
  private readonly floorRelease: number;
  private noiseFloorDb: number | null = null;

  constructor(opts: EnergyVadOptions = {}) {
    this.absSilenceDb = opts.absSilenceDb ?? -60;
    this.onsetLowDb = opts.onsetLowDb ?? 6;
    this.onsetHighDb = opts.onsetHighDb ?? 12;
    this.floorAttack = opts.floorAttack ?? 0.9;
    this.floorRelease = opts.floorRelease ?? 0.02;
  }

  reset(): void {
    this.noiseFloorDb = null;
  }

  speechProbability(frame: Float32Array): number {
    const db = toDb(frameRms(frame));

    if (this.noiseFloorDb === null) {
      this.noiseFloorDb = db;
    } else if (db < this.noiseFloorDb) {
      this.noiseFloorDb += this.floorAttack * (db - this.noiseFloorDb);
    } else {
      this.noiseFloorDb += this.floorRelease * (db - this.noiseFloorDb);
    }

    if (db <= this.absSilenceDb) return 0;

    const snr = db - this.noiseFloorDb;
    if (snr <= this.onsetLowDb) return 0;
    if (snr >= this.onsetHighDb) return 1;
    return (snr - this.onsetLowDb) / (this.onsetHighDb - this.onsetLowDb);
  }
}

export interface SmoothedVadOptions {
  frameMs?: number;
  /** Startup warm-up window for the adaptive floor; no speech emitted. */
  prefillMs?: number;
  /** Consecutive above-threshold time required to enter speech. */
  onsetMs?: number;
  /** Consecutive below-threshold time required to leave speech. */
  hangoverMs?: number;
  /** Probability threshold for a frame to count as speech. */
  threshold?: number;
  /** Frame classifier. Defaults to {@link EnergyVad}. */
  model?: FrameVad;
}

export interface VadFrameResult {
  probability: number;
  /** Smoothed speech decision after onset/hangover. */
  isSpeech: boolean;
}

/**
 * Onset/hangover smoothing over a {@link FrameVad}, mirroring Handy's
 * `SmoothedVad`. Feed frames in order via {@link process}.
 */
export class SmoothedVad {
  readonly onsetFrames: number;
  readonly hangoverFrames: number;
  readonly prefillFrames: number;
  private readonly threshold: number;
  private readonly model: FrameVad;

  private framesSeen = 0;
  private speech = false;
  private aboveRun = 0;
  private belowRun = 0;

  constructor(opts: SmoothedVadOptions = {}) {
    const frameMs = opts.frameMs ?? VAD_FRAME_MS;
    this.onsetFrames = Math.max(1, Math.ceil((opts.onsetMs ?? 60) / frameMs));
    this.hangoverFrames = Math.max(1, Math.ceil((opts.hangoverMs ?? 450) / frameMs));
    this.prefillFrames = Math.max(0, Math.ceil((opts.prefillMs ?? 450) / frameMs));
    this.threshold = opts.threshold ?? 0.5;
    this.model = opts.model ?? new EnergyVad();
  }

  reset(): void {
    this.framesSeen = 0;
    this.speech = false;
    this.aboveRun = 0;
    this.belowRun = 0;
    this.model.reset();
  }

  get isSpeech(): boolean {
    return this.speech;
  }

  process(frame: Float32Array): VadFrameResult {
    const probability = this.model.speechProbability(frame);
    const above = probability >= this.threshold;
    this.framesSeen++;

    // During prefill, adapt the floor but never report speech so a noisy
    // first breath can't false-trigger onset.
    if (this.framesSeen <= this.prefillFrames) {
      return { probability, isSpeech: false };
    }

    if (above) {
      this.aboveRun++;
      this.belowRun = 0;
    } else {
      this.belowRun++;
      this.aboveRun = 0;
    }

    if (!this.speech) {
      if (this.aboveRun >= this.onsetFrames) this.speech = true;
    } else if (this.belowRun >= this.hangoverFrames) {
      this.speech = false;
    }

    return { probability, isSpeech: this.speech };
  }
}

/**
 * Split a mono PCM buffer into fixed-size frames. The final partial
 * frame (if any) is zero-padded to `frameSamples`.
 */
export function toFrames(pcm: Float32Array, frameSamples = VAD_FRAME_SAMPLES): Float32Array[] {
  const frames: Float32Array[] = [];
  for (let i = 0; i < pcm.length; i += frameSamples) {
    const end = Math.min(pcm.length, i + frameSamples);
    if (end - i === frameSamples) {
      frames.push(pcm.subarray(i, end));
    } else {
      const padded = new Float32Array(frameSamples);
      padded.set(pcm.subarray(i, end));
      frames.push(padded);
    }
  }
  return frames;
}
