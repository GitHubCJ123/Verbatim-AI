/**
 * Post-hoc silence trimming (docs/proposals/handy-adoption.md §Phase 4a).
 *
 * Runs the {@link SmoothedVad} over already-captured 16 kHz mono PCM to
 * trim leading/trailing silence before transcription (reduces Whisper
 * silence-hallucination and shortens the clip handed to the engine) and
 * to flag clips that are pure silence/noise.
 *
 * Design priority: **never cut speech.** Every heuristic here fails
 * *open* — when the detector is unsure it returns the original audio
 * untouched. It only ever trims the two outer edges (never internal
 * gaps) and always keeps generous padding around detected speech.
 */
import {
  SmoothedVad,
  peakAbs,
  toFrames,
  VAD_FRAME_SAMPLES,
  VAD_FRAME_MS,
  VAD_SAMPLE_RATE,
  type SmoothedVadOptions,
} from "./vad";

export interface TrimOptions extends SmoothedVadOptions {
  sampleRate?: number;
  /** Extra padding (ms) kept on each side beyond detected speech. */
  padMs?: number;
  /**
   * Peak amplitude below which a clip with no detected speech is treated
   * as pure silence/noise and reported as silent. Deliberately tiny so
   * quiet speech is never dropped.
   */
  silencePeak?: number;
  /** Don't bother trimming an edge unless it removes at least this much. */
  minEdgeTrimMs?: number;
  /** Never return a trimmed clip shorter than this. */
  minKeepMs?: number;
}

export interface TrimResult {
  /** Trimmed PCM (or the original buffer if nothing was trimmed). */
  pcm: Float32Array;
  /** True when the clip contains no detectable speech and ~no energy. */
  isSilent: boolean;
  /** Whether any samples were actually removed. */
  trimmed: boolean;
  leadingTrimmedMs: number;
  trailingTrimmedMs: number;
  /** Duration of the returned clip in ms. */
  keptMs: number;
}

/**
 * Trim leading/trailing silence from a mono PCM buffer.
 *
 * @param pcm  16 kHz mono Float32 samples in [-1, 1].
 */
export function trimSilence(pcm: Float32Array, opts: TrimOptions = {}): TrimResult {
  const sampleRate = opts.sampleRate ?? VAD_SAMPLE_RATE;
  const frameSamples =
    sampleRate === VAD_SAMPLE_RATE
      ? VAD_FRAME_SAMPLES
      : Math.round((sampleRate * (opts.frameMs ?? VAD_FRAME_MS)) / 1000);
  const frameMs = (frameSamples / sampleRate) * 1000;
  const padMs = opts.padMs ?? 200;
  const padFrames = Math.ceil(padMs / frameMs);
  const silencePeak = opts.silencePeak ?? 0.02;
  const minEdgeTrimMs = opts.minEdgeTrimMs ?? 120;
  const minKeepMs = opts.minKeepMs ?? 300;

  const totalMs = (pcm.length / sampleRate) * 1000;
  const untouched = (): TrimResult => ({
    pcm,
    isSilent: false,
    trimmed: false,
    leadingTrimmedMs: 0,
    trailingTrimmedMs: 0,
    keptMs: totalMs,
  });

  // Too short to reason about — leave it alone.
  if (pcm.length < frameSamples * 2) return untouched();

  const vad = new SmoothedVad({ ...opts, frameMs });
  const frames = toFrames(pcm, frameSamples);

  let firstSpeech = -1;
  let lastSpeech = -1;
  for (let i = 0; i < frames.length; i++) {
    const { isSpeech } = vad.process(frames[i]);
    if (isSpeech) {
      if (firstSpeech === -1) firstSpeech = i;
      lastSpeech = i;
    }
  }

  if (firstSpeech === -1) {
    // No speech detected. Only declare "silent" when there is almost no
    // energy anywhere — otherwise fail open and keep the audio so quiet
    // speech in a noisy room is never dropped.
    const isSilent = peakAbs(pcm) < silencePeak;
    return { ...untouched(), isSilent };
  }

  // The smoothed decision turns true `onsetFrames` *after* speech truly
  // began, so rewind by the onset window; the trailing edge already
  // includes the hangover tail. Then add symmetric padding.
  const startFrame = Math.max(0, firstSpeech - vad.onsetFrames - padFrames);
  const endFrame = Math.min(frames.length - 1, lastSpeech + padFrames);

  let startSample = startFrame * frameSamples;
  let endSample = Math.min(pcm.length, (endFrame + 1) * frameSamples);

  const leadingMs = (startSample / sampleRate) * 1000;
  const trailingMs = ((pcm.length - endSample) / sampleRate) * 1000;

  // Don't churn the buffer for tiny edge gains.
  if (leadingMs < minEdgeTrimMs) startSample = 0;
  if (trailingMs < minEdgeTrimMs) endSample = pcm.length;

  if (startSample === 0 && endSample === pcm.length) return untouched();

  // Guard the minimum retained length.
  if (((endSample - startSample) / sampleRate) * 1000 < minKeepMs) return untouched();

  const trimmedPcm = pcm.slice(startSample, endSample);
  return {
    pcm: trimmedPcm,
    isSilent: false,
    trimmed: true,
    leadingTrimmedMs: (startSample / sampleRate) * 1000,
    trailingTrimmedMs: ((pcm.length - endSample) / sampleRate) * 1000,
    keptMs: (trimmedPcm.length / sampleRate) * 1000,
  };
}
