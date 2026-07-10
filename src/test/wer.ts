/**
 * Word Error Rate for engine golden tests.
 *
 * Normalizes both strings (lowercase, strip punctuation, collapse
 * whitespace), then computes the Levenshtein edit distance over word
 * tokens divided by the reference word count. Identical text (after
 * normalization) is 0; lower is better. Used to assert that a real
 * transcription engine got "close enough" to a known utterance without
 * demanding an exact match.
 */

/** Lowercase, drop punctuation/symbols, split into word tokens. */
export function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalized word-level error rate of `hypothesis` against `reference`. */
export function wer(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  // Levenshtein over word arrays, rolling single-row DP.
  const d: number[] = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const tmp = d[j];
      d[j] =
        ref[i - 1] === hyp[j - 1]
          ? prev
          : Math.min(prev, d[j], d[j - 1]) + 1;
      prev = tmp;
    }
  }
  return d[hyp.length] / ref.length;
}
