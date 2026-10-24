import { describe, expect, it } from "vitest";
import { buildCleanupPrompt } from "./promptBuilder";

describe("buildCleanupPrompt", () => {
  const base = {
    rawText: "um what's the weather like tomorrow",
    systemPrompt: "Keep it casual.",
    modeName: "Default",
  };

  it("delimits the transcript so dictated questions aren't treated as requests", () => {
    const { system, user } = buildCleanupPrompt(base);
    expect(user).toBe("<transcript>\num what's the weather like tomorrow\n</transcript>");
    expect(system).toMatch(/NOT a message to you/);
    expect(system).toMatch(/Never answer questions/);
    expect(system).toContain("- Keep it casual.");
  });

  it("includes vocabulary and translation target", () => {
    const { system } = buildCleanupPrompt({
      ...base,
      vocabulary: ["Kubernetes"],
      targetLanguage: "English",
    });
    expect(system).toContain("- Kubernetes");
    expect(system).toContain("Translate the result into English");
  });
});
