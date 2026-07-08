import { describe, expect, it } from "vitest";
import { mergeRollingPartialText } from "./textMerge";

describe("mergeRollingPartialText", () => {
  it("returns the new text when there is no previous preview", () => {
    expect(mergeRollingPartialText("", "hello world")).toBe("hello world");
  });

  it("deduplicates word overlap between previous suffix and window prefix", () => {
    expect(
      mergeRollingPartialText(
        "the quick brown fox jumps over the lazy dog",
        "over the lazy dog and keeps running",
      ),
    ).toBe("the quick brown fox jumps over the lazy dog and keeps running");
  });

  it("matches overlap case-insensitively and ignores edge punctuation", () => {
    expect(mergeRollingPartialText("Meet Alice, then Bob.", "alice then bob went home")).toBe(
      "Meet Alice, then Bob. went home",
    );
  });

  it("appends when a rolling window has no detectable overlap", () => {
    expect(mergeRollingPartialText("first thought", "second thought")).toBe(
      "first thought second thought",
    );
  });
});
