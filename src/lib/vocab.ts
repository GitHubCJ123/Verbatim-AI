import type { VocabularyTerm } from "../types/mode";

export const MAX_VOCABULARY_TERM_LENGTH = 200;

/** One explicit term or phrase, never an entire multi-line dictation. */
export function validateVocabularyTerm(
  input: string,
  terms: VocabularyTerm[],
  excludeId?: string,
): string {
  const term = input.trim();
  if (!term) throw new Error("Enter a term or short phrase.");
  if (
    Array.from(term).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error("Use a single-line term without control characters.");
  }
  if (term.length > MAX_VOCABULARY_TERM_LENGTH) {
    throw new Error(`Use at most ${MAX_VOCABULARY_TERM_LENGTH} characters.`);
  }
  const key = term.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
  if (
    terms.some(
      (entry) =>
        entry.id !== excludeId &&
        entry.term.trim().normalize("NFKC").toLowerCase().replace(/\s+/gu, " ") === key,
    )
  ) {
    throw new Error("This term is already in Vocabulary.");
  }
  return term;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply vocabulary replacements to text. Each term with a non-null
 * `replacement` is replaced case-insensitively as a whole word.
 *
 * If the replacement contains any uppercase letters, it's used as-is.
 * Otherwise we preserve the match's starting capitalization.
 */
export function applyVocabReplacements(text: string, terms: VocabularyTerm[]): string {
  let out = text;
  for (const t of terms) {
    const target = t.replacement?.trim();
    if (!target) continue;
    const src = t.term.trim();
    if (!src) continue;
    const rx = new RegExp(`\\b${escapeRegex(src)}\\b`, "gi");
    const replacementHasCase = /[A-Z]/.test(target);
    out = out.replace(rx, (match) => {
      if (replacementHasCase) return target;
      const first = match[0];
      if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
        return target.charAt(0).toUpperCase() + target.slice(1);
      }
      return target;
    });
  }
  return out;
}
