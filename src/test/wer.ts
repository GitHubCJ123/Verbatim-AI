/**
 * Word Error Rate for engine golden tests.
 *
 * Normalizes both strings (see `src/lib/ai/wordErrorRate.ts`), then computes
 * the Levenshtein edit distance over word tokens divided by the reference
 * word count. Identical text (after normalization) is 0; lower is better.
 * Used to assert that a real transcription engine got "close enough" to a
 * known utterance without demanding an exact match.
 */
import { wordErrors } from "../lib/ai/wordErrorRate";

export { normalizeWords } from "../lib/ai/wordErrorRate";

/** Normalized word-level error rate of `hypothesis` against `reference`. */
export function wer(reference: string, hypothesis: string): number {
  const { errors, words } = wordErrors(reference, hypothesis);
  if (words === 0) return errors === 0 ? 0 : 1;
  return errors / words;
}
