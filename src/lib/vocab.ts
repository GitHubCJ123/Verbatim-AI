import type { VocabularyTerm } from "../types/mode";

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
