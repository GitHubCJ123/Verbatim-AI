import { describe, it, expect } from "vitest";
import { wer, normalizeWords } from "./wer";

describe("normalizeWords", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeWords("Hey!!  There... World?")).toEqual(["hey", "there", "world"]);
  });
});

describe("wer", () => {
  it("is 0 for text that is identical after normalization", () => {
    expect(wer("Hello, world!", "hello world")).toBe(0);
  });

  it("counts a single substitution", () => {
    expect(wer("hello world", "hello there")).toBeCloseTo(0.5);
  });

  it("counts an insertion and a deletion as 1/refLen each", () => {
    expect(wer("a b c", "a b c d")).toBeCloseTo(1 / 3);
    expect(wer("a b c", "a c")).toBeCloseTo(1 / 3);
  });

  it("handles empty reference", () => {
    expect(wer("", "")).toBe(0);
    expect(wer("", "x")).toBe(1);
  });
});
