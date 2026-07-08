/**
 * Inline, LLM-free post-processing for raw transcripts.
 *
 * Two deterministic steps, both OFF by default and independently toggleable:
 *   1. Filler-word filter  — strip um/uh/er/hmm/you-know at word boundaries.
 *   2. Fuzzy vocab correction — Levenshtein-based near-miss fix for
 *      terms in the user's vocabulary store.
 *
 * Both functions are pure and unit-testable (no localStorage, no I/O).
 *
 * Design note (Phase 7 / P2.9):
 *   Wired in Overlay.tsx between the transcription step and the cleanup-LLM
 *   step so that fillers are absent from the LLM context and near-miss vocab
 *   terms are corrected before the prompt is sent.
 */
import type { VocabularyTerm } from "../types/mode";

// ─── Constants ─────────────────────────────────────────────────────────────

/** Minimum word length required before fuzzy matching is attempted. */
export const FUZZY_MIN_WORD_LEN = 4;

/** Default Levenshtein threshold when not overridden by the caller. */
export const DEFAULT_FUZZY_THRESHOLD = 1;

/**
 * Conservative default filler set: words that are exclusively disfluencies
 * in English speech and have no legitimate substitute use as real words.
 *
 * "like" is intentionally absent — it is a high-frequency English verb,
 * adjective, and preposition; safe removal without syntax analysis is
 * not possible.
 */
export const DEFAULT_FILLERS: readonly string[] = [
  "um",
  "uh",
  "er",
  "hmm",
  "you know",
];

// ─── Internal helpers ──────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Levenshtein edit distance ─────────────────────────────────────────────

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Uses the two-row iterative algorithm: O(m*n) time, O(min(m,n)) space.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string in the inner loop for memory efficiency.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);

  for (let j = 1; j <= b.length; j++) {
    const curr: number[] = [j];
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,        // deletion
        curr[i - 1] + 1,    // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    prev = curr;
  }

  return prev[a.length];
}

/**
 * Return the per-term fuzzy threshold.
 * Longer terms can tolerate one additional edit; `maxThreshold` caps it.
 */
function thresholdFor(termLen: number, maxThreshold: number): number {
  if (termLen < FUZZY_MIN_WORD_LEN) return 0;
  if (termLen >= 8) return Math.min(2, maxThreshold);
  return Math.min(1, maxThreshold);
}

// ─── 1. Filler-word filter ─────────────────────────────────────────────────

/**
 * Strip filler words and phrases from `text`.
 *
 * Matching is whole-word only (`\b` boundaries, case-insensitive).
 * Adjacent comma / period delimiters are absorbed so the surrounding
 * clause is left grammatically clean.  Extra spaces are collapsed.
 *
 * Passing an empty `fillers` array is an explicit no-op.
 */
export function stripFillers(
  text: string,
  fillers: readonly string[] = DEFAULT_FILLERS,
): string {
  if (!text || fillers.length === 0) return text;

  // Longest phrases first so "you know" matches before any sub-phrase.
  const sorted = [...fillers].sort((a, b) => b.length - a.length);
  let out = text;

  for (const filler of sorted) {
    // Normalise internal whitespace in the filler to \s+ so both
    // "you  know" and "you know" in the source text match.
    const esc = escapeRegex(filler.trim()).replace(/\s+/g, "\\s+");

    // Pattern: optional leading spaces, whole-word filler, optional
    // trailing comma or period, optional trailing spaces.
    // Leading commas are intentionally NOT absorbed so the surrounding
    // clause keeps its punctuation (e.g. "I think, um, we" → "I think, we").
    const rx = new RegExp(`\\s*\\b${esc}\\b[,.]?\\s*`, "gi");
    out = out.replace(rx, " ");
  }

  // Collapse runs of spaces and trim.
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

// ─── 2. Fuzzy vocabulary correction ───────────────────────────────────────

/**
 * Replace near-miss word recognitions with the canonical vocabulary term.
 *
 * Conservative rules applied per word:
 * - Words shorter than FUZZY_MIN_WORD_LEN are never modified.
 * - Multi-word vocabulary entries are skipped (handled downstream by
 *   `applyVocabReplacements`).
 * - Exact matches (case-insensitive) are also skipped — left for
 *   `applyVocabReplacements` which already handles them correctly.
 * - If more than one term matches within the threshold the word is left
 *   unchanged (ambiguous — don't guess).
 * - If the canonical term contains any uppercase letter it is assumed to
 *   be a proper noun and returned as-is; otherwise the original word's
 *   leading capitalisation is mirrored.
 */
export function fuzzyVocabCorrect(
  text: string,
  terms: VocabularyTerm[],
  threshold: number = DEFAULT_FUZZY_THRESHOLD,
): string {
  if (!text || terms.length === 0) return text;

  // Build a list of single-word terms that are long enough to fuzzy-match.
  const candidates = terms
    .map((t) => t.term.trim())
    .filter((t) => t.length >= FUZZY_MIN_WORD_LEN && !/\s/.test(t));

  if (candidates.length === 0) return text;

  // Replace each eligible word token while leaving everything else intact.
  return text.replace(/\b[a-zA-Z]{4,}\b/g, (word) => {
    const lword = word.toLowerCase();
    const matches: string[] = [];

    for (const canonical of candidates) {
      const lterm = canonical.toLowerCase();
      // Exact match: leave for applyVocabReplacements downstream.
      if (lword === lterm) return word;
      const limit = thresholdFor(canonical.length, threshold);
      if (limit === 0) continue;
      if (levenshtein(lword, lterm) <= limit) {
        matches.push(canonical);
      }
    }

    if (matches.length !== 1) return word; // no match or ambiguous

    const best = matches[0];
    // Proper-noun / mixed-case term: use canonical capitalisation.
    if (/[A-Z]/.test(best)) return best;
    // Mirror original word's leading capitalisation.
    if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
      return best.charAt(0).toUpperCase() + best.slice(1);
    }
    return best;
  });
}

// ─── Main entry point ──────────────────────────────────────────────────────

export interface PostProcessOptions {
  /**
   * Enable filler-word stripping.
   * Default: false — output is unchanged when this is absent or false.
   */
  fillerFilter?: boolean;
  /**
   * Custom filler list to use when `fillerFilter` is true.
   * Defaults to `DEFAULT_FILLERS` when omitted.
   */
  customFillers?: string[];
  /**
   * Enable fuzzy vocabulary correction.
   * Default: false — output is unchanged when this is absent or false.
   */
  fuzzyVocab?: boolean;
  /** Vocabulary terms from the user's store; required when `fuzzyVocab` is true. */
  vocabularyTerms?: VocabularyTerm[];
  /**
   * Override the Levenshtein threshold used by fuzzy correction.
   * Defaults to `DEFAULT_FUZZY_THRESHOLD` (1).
   */
  fuzzyThreshold?: number;
}

/**
 * Apply all enabled inline post-processing steps to a raw transcript.
 *
 * Steps applied in order:
 *   1. Filler-word filter (when `fillerFilter: true`).
 *   2. Fuzzy vocabulary correction (when `fuzzyVocab: true` and terms provided).
 *
 * When no options are set (or both are false) the original text is
 * returned **unchanged**, guaranteeing zero regression for the default
 * pipeline.
 */
export function applyInlinePostProcessing(
  text: string,
  options: PostProcessOptions = {},
): string {
  let out = text;

  if (options.fillerFilter) {
    out = stripFillers(out, options.customFillers ?? DEFAULT_FILLERS);
  }

  if (options.fuzzyVocab && options.vocabularyTerms && options.vocabularyTerms.length > 0) {
    out = fuzzyVocabCorrect(out, options.vocabularyTerms, options.fuzzyThreshold);
  }

  return out;
}
