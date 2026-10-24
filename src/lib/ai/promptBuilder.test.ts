import { describe, expect, it } from "vitest";
import { buildCleanupMessages, cleanupTokenBudget } from "./promptBuilder";

const base = {
  rawText: "um what's the weather like tomorrow",
  systemPrompt: "Keep it casual.",
  modeName: "Casual",
  modeDescription: "Clear, friendly sentences.",
};

describe("buildCleanupMessages", () => {
  it("delimits the transcript so dictated questions aren't treated as requests", () => {
    const messages = buildCleanupMessages(base);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toMatch(/never addressed to you/);
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "<transcript>um what's the weather like tomorrow</transcript>",
    });
  });

  it("puts the mode's style in the prompt and skips examples for restyling modes", () => {
    const messages = buildCleanupMessages(base);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("Keep it casual.");
    expect(messages[0].content).toContain('"Casual (Clear, friendly sentences.)" mode');
  });

  it("tags the transcript and examples with their language so small models don't translate", () => {
    const messages = buildCleanupMessages({
      ...base,
      rawText: "je pense que on peut finir demain",
      lightCleanup: true,
      language: "fr",
    });
    expect(messages[0].content).toContain("transcript's lang attribute");
    expect(messages[messages.length - 1].content).toBe(
      '<transcript lang="fr">je pense que on peut finir demain</transcript>',
    );
    expect(messages[1].content).toMatch(/^<transcript lang="en">/);
  });

  it("replaces the keep-language rule with the translation target", () => {
    const [system, user] = buildCleanupMessages({
      ...base,
      language: "fr",
      targetLanguage: "English",
    });
    expect(system.content).toContain("Translate the result into English");
    expect(system.content).not.toContain("Never translate");
    expect(user.content).toBe("<transcript>um what's the weather like tomorrow</transcript>");
  });

  it("adds worked examples as prior turns for light cleanup", () => {
    const messages = buildCleanupMessages({ ...base, lightCleanup: true });
    expect(messages.length).toBeGreaterThan(10);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toMatch(/^<transcript>.*<\/transcript>$/);
    expect(messages[2].role).toBe("assistant");
    expect(messages[0].content).not.toContain("Keep it casual.");
  });

  it("includes vocabulary and translation target", () => {
    const [system] = buildCleanupMessages({
      ...base,
      vocabulary: ["Kubernetes"],
      targetLanguage: "English",
    });
    expect(system.content).toContain("- Kubernetes");
    expect(system.content).toContain("Translate the result into English");
  });
});

describe("cleanupTokenBudget", () => {
  it("keeps light cleanup close to the input length", () => {
    const rawText = "word ".repeat(100);
    expect(cleanupTokenBudget({ ...base, rawText, lightCleanup: true })).toBe(
      Math.ceil(125 * 1.6) + 64,
    );
  });

  it("allows restyles and translations to grow", () => {
    const rawText = "word ".repeat(100);
    expect(cleanupTokenBudget({ ...base, rawText })).toBe(125 * 3 + 64);
    expect(
      cleanupTokenBudget({ ...base, rawText, lightCleanup: true, targetLanguage: "French" }),
    ).toBe(125 * 3 + 64);
  });

  it("budgets non-Latin scripts at about a token per character", () => {
    const rawText = "我们明天下午三点开会";
    expect(cleanupTokenBudget({ ...base, rawText, lightCleanup: true })).toBe(
      Math.ceil(10 * 1.6) + 64,
    );
  });

  it("never exceeds the engine cap", () => {
    expect(cleanupTokenBudget({ ...base, rawText: "x".repeat(100_000) })).toBe(4096);
  });
});
