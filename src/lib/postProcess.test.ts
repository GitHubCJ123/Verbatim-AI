import { describe, it, expect } from "vitest";
import {
  levenshtein,
  stripFillers,
  fuzzyVocabCorrect,
  applyInlinePostProcessing,
  DEFAULT_FILLERS,
  FUZZY_MIN_WORD_LEN,
  DEFAULT_FUZZY_THRESHOLD,
} from "./postProcess";
import type { VocabularyTerm } from "../types/mode";

// ─── Test helpers ──────────────────────────────────────────────────────────

function mkTerm(id: string, termText: string): VocabularyTerm {
  return {
    id,
    term: termText,
    pronunciation: null,
    replacement: null,
    notes: null,
    createdAt: new Date().toISOString(),
  };
}

// ─── levenshtein ───────────────────────────────────────────────────────────

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("equals the length of the other string when one is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts a single substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("counts a single insertion — near-miss ASR output", () => {
    // "Verbatm" → "Verbatim": insert 'i'
    expect(levenshtein("Verbatm", "Verbatim")).toBe(1);
  });

  it("counts a single deletion", () => {
    // "Verbatim" → "Verbatm": delete 'i'
    expect(levenshtein("Verbatim", "Verbatm")).toBe(1);
  });

  it("is symmetric", () => {
    expect(levenshtein("abc", "xyz")).toBe(levenshtein("xyz", "abc"));
    expect(levenshtein("Verbatm", "Verbatim")).toBe(levenshtein("Verbatim", "Verbatm"));
  });

  it("handles transposition as two edits", () => {
    // Standard Levenshtein (not Damerau) counts transposition as 2.
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("computes a typical near-miss for a technical term", () => {
    // "tensrflow" → "tensorflow": one insertion of 'o'
    expect(levenshtein("tensrflow", "tensorflow")).toBe(1);
  });
});

// ─── stripFillers ──────────────────────────────────────────────────────────

describe("stripFillers", () => {
  it("is a no-op on empty text", () => {
    expect(stripFillers("", DEFAULT_FILLERS)).toBe("");
  });

  it("is a no-op when the filler list is empty", () => {
    expect(stripFillers("um, I think", [])).toBe("um, I think");
  });

  it("removes a sentence-initial filler with trailing comma+space", () => {
    expect(stripFillers("Um, I think we should go.", DEFAULT_FILLERS)).toBe(
      "I think we should go.",
    );
  });

  it("removes a mid-sentence filler and preserves the preceding comma", () => {
    expect(stripFillers("I think, um, we should go.", DEFAULT_FILLERS)).toBe(
      "I think, we should go.",
    );
  });

  it("removes a trailing filler", () => {
    expect(stripFillers("I think, um", DEFAULT_FILLERS)).toBe("I think,");
  });

  it("removes multiple different fillers in one pass", () => {
    expect(
      stripFillers("Um, I was, uh, thinking about that.", DEFAULT_FILLERS),
    ).toBe("I was, thinking about that.");
  });

  it("removes the two-word filler 'you know'", () => {
    expect(stripFillers("I was, you know, happy.", DEFAULT_FILLERS)).toBe(
      "I was, happy.",
    );
  });

  it("removes 'hmm' filler", () => {
    expect(stripFillers("Hmm, that is interesting.", DEFAULT_FILLERS)).toBe(
      "that is interesting.",
    );
  });

  it("does not touch words that merely contain filler letters", () => {
    // 'um' must not match inside 'Umbrella'
    expect(stripFillers("Umbrella is useful.", DEFAULT_FILLERS)).toBe(
      "Umbrella is useful.",
    );
  });

  it("is case-insensitive", () => {
    expect(stripFillers("UH, that's great.", DEFAULT_FILLERS)).toBe(
      "that's great.",
    );
  });

  it("returns text unchanged when no fillers are present", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(stripFillers(text, DEFAULT_FILLERS)).toBe(text);
  });

  it("does not leave double spaces after removal", () => {
    const result = stripFillers("Hello um world", DEFAULT_FILLERS);
    expect(result).not.toMatch(/  /);
    expect(result).toBe("Hello world");
  });

  it("uses a custom filler list when provided", () => {
    const result = stripFillers("Like, that was amazing.", ["like"]);
    expect(result).toBe("that was amazing.");
  });

  it("exported DEFAULT_FILLERS contains the conservative set", () => {
    expect(DEFAULT_FILLERS).toContain("um");
    expect(DEFAULT_FILLERS).toContain("uh");
    expect(DEFAULT_FILLERS).toContain("er");
    expect(DEFAULT_FILLERS).toContain("hmm");
    expect(DEFAULT_FILLERS).toContain("you know");
    // 'like' must NOT be in the default set (too many false positives).
    expect(DEFAULT_FILLERS).not.toContain("like");
  });
});

// ─── fuzzyVocabCorrect ─────────────────────────────────────────────────────

describe("fuzzyVocabCorrect", () => {
  const terms = [
    mkTerm("1", "Verbatim"),
    mkTerm("2", "TensorFlow"),
    mkTerm("3", "Kubernetes"),
  ];

  it("is a no-op on empty text", () => {
    expect(fuzzyVocabCorrect("", terms)).toBe("");
  });

  it("is a no-op when the terms array is empty", () => {
    expect(fuzzyVocabCorrect("Hello world Verbatm", [])).toBe(
      "Hello world Verbatm",
    );
  });

  it("corrects a near-miss that is one edit from a vocabulary term", () => {
    expect(fuzzyVocabCorrect("I use Verbatm AI", terms)).toBe(
      "I use Verbatim AI",
    );
  });

  it("leaves exact matches unchanged (for applyVocabReplacements downstream)", () => {
    expect(fuzzyVocabCorrect("I use Verbatim AI", terms)).toBe(
      "I use Verbatim AI",
    );
  });

  it("does not replace when multiple terms match within threshold (ambiguous)", () => {
    const ambiguous = [mkTerm("a", "abcde"), mkTerm("b", "abcdf")];
    // "abcdd" is 1 edit from both "abcde" and "abcdf"
    expect(fuzzyVocabCorrect("abcdd is here", ambiguous)).toBe("abcdd is here");
  });

  it(`does not replace words shorter than FUZZY_MIN_WORD_LEN (${FUZZY_MIN_WORD_LEN})`, () => {
    // Regex only captures words of 4+ chars, so 3-char words are untouched.
    const shortInput = "abd is wrong";
    expect(fuzzyVocabCorrect(shortInput, [mkTerm("x", "abcd")])).toBe(shortInput);
  });

  it("skips vocabulary terms shorter than FUZZY_MIN_WORD_LEN", () => {
    // A 3-char term must not cause spurious corrections.
    expect(fuzzyVocabCorrect("cats and dogs", [mkTerm("y", "cat")])).toBe(
      "cats and dogs",
    );
  });

  it("preserves proper-noun capitalisation from the canonical term", () => {
    // "tensrflow" → "TensorFlow" (mixed-case canonical wins)
    expect(fuzzyVocabCorrect("I use tensrflow", terms)).toBe("I use TensorFlow");
  });

  it("mirrors original sentence-initial capitalisation for lowercase terms", () => {
    const lower = [mkTerm("z", "verbatim")];
    expect(fuzzyVocabCorrect("Verbatm is great", lower)).toBe("Verbatim is great");
  });

  it("skips multi-word vocabulary terms (handled by applyVocabReplacements)", () => {
    const multiWord = [mkTerm("m", "Verbatim AI")];
    // "Verbatm AI" should NOT be fuzzy-corrected since the term has a space.
    expect(fuzzyVocabCorrect("Verbatm AI", multiWord)).toBe("Verbatm AI");
  });

  it("returns text unchanged when no near-misses exist", () => {
    const text = "This sentence has no vocabulary near-misses at all.";
    expect(fuzzyVocabCorrect(text, terms)).toBe(text);
  });

  it("exported DEFAULT_FUZZY_THRESHOLD is 1 (conservative default)", () => {
    expect(DEFAULT_FUZZY_THRESHOLD).toBe(1);
  });
});

// ─── applyInlinePostProcessing ─────────────────────────────────────────────

describe("applyInlinePostProcessing", () => {
  it("is a no-op when called with no options", () => {
    const text = "Um, I think you know, uh, we should go.";
    expect(applyInlinePostProcessing(text)).toBe(text);
  });

  it("is a no-op when both features are explicitly disabled", () => {
    const text = "Um, I think, uh, we should go.";
    expect(
      applyInlinePostProcessing(text, { fillerFilter: false, fuzzyVocab: false }),
    ).toBe(text);
  });

  it("applies the filler filter when fillerFilter: true", () => {
    const text = "Um, I think we should go.";
    const result = applyInlinePostProcessing(text, { fillerFilter: true });
    expect(result).not.toMatch(/\bum\b/i);
    expect(result).toContain("I think we should go.");
  });

  it("applies fuzzy vocab correction when fuzzyVocab: true with terms", () => {
    const terms = [mkTerm("1", "Verbatim")];
    const result = applyInlinePostProcessing("I use Verbatm AI", {
      fuzzyVocab: true,
      vocabularyTerms: terms,
    });
    expect(result).toBe("I use Verbatim AI");
  });

  it("fuzzyVocab: true with empty terms is a no-op", () => {
    const text = "Hello Verbatm";
    expect(
      applyInlinePostProcessing(text, { fuzzyVocab: true, vocabularyTerms: [] }),
    ).toBe(text);
    expect(applyInlinePostProcessing(text, { fuzzyVocab: true })).toBe(text);
  });

  it("applies both steps in order — filler first, then fuzzy vocab", () => {
    const terms = [mkTerm("1", "Kubernetes")];
    // "Um, Kubernetss is great." → strip "Um," → "Kubernetss is great." → fix to "Kubernetes is great."
    const result = applyInlinePostProcessing("Um, Kubernetss is great.", {
      fillerFilter: true,
      fuzzyVocab: true,
      vocabularyTerms: terms,
    });
    expect(result).not.toMatch(/\bum\b/i);
    expect(result).toContain("Kubernetes");
  });

  it("respects a custom filler list", () => {
    const result = applyInlinePostProcessing("Like, that was cool.", {
      fillerFilter: true,
      customFillers: ["like"],
    });
    expect(result).toBe("that was cool.");
  });

  it("uses customFillers instead of DEFAULT_FILLERS when provided", () => {
    // DEFAULT_FILLERS contains "um"; with custom list that omits "um",
    // "um" should survive.
    const result = applyInlinePostProcessing("Um, like, cool.", {
      fillerFilter: true,
      customFillers: ["like"],
    });
    expect(result).toMatch(/\bum\b/i);
    expect(result).not.toMatch(/\blike\b/i);
  });
});
