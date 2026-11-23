/**
 * Word error rate, shared by the in-app speech benchmark and engine tests.
 *
 * Both texts are normalized the same way (lowercase, punctuation to spaces,
 * a few spelling variants unified) so a model isn't penalized for style, then
 * scored as the word-level edit distance against the reference.
 */

// Applied to both sides, so either spelling counts as correct. Covers the
// variants that appear in the bundled benchmark references.
const EQUIVALENT_SPELLINGS: Record<string, string> = {
  neighbourhood: "neighborhood",
  centres: "centers",
  anyone: "any one",
  schoolgirls: "school girls",
  boxcar: "box car",
  workaday: "work a day",
};

/** Lowercase, drop punctuation/symbols, split into word tokens. */
export function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => (EQUIVALENT_SPELLINGS[w] ?? w).split(" "));
}

/** Substitutions + insertions + deletions turning `ref` into `hyp`. */
function editDistance(ref: string[], hyp: string[]): number {
  const d: number[] = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const tmp = d[j];
      d[j] = ref[i - 1] === hyp[j - 1] ? prev : Math.min(prev, d[j], d[j - 1]) + 1;
      prev = tmp;
    }
  }
  return d[hyp.length];
}

/** Word errors in `hypothesis` and the reference's word count. */
export function wordErrors(
  reference: string,
  hypothesis: string,
): { errors: number; words: number } {
  const ref = normalizeWords(reference);
  return { errors: editDistance(ref, normalizeWords(hypothesis)), words: ref.length };
}
