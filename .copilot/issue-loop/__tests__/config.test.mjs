import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, modelFamily, validateConfig } from "../lib/config.mjs";

describe("issue loop config", () => {
  it("requires architect and adversarial reviewer model diversity", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.adversarialReviewer.model = config.agents.architect.model;

    expect(() => validateConfig(config)).toThrow(/must differ/);
  });

  it("classifies model families", () => {
    expect(modelFamily("gpt-5.5")).toBe("openai");
    expect(modelFamily("claude-opus-4.8")).toBe("anthropic");
    expect(modelFamily("gemini-3.1-pro")).toBe("google");
  });

  it("triages all open issues for requirements clarity by default", () => {
    expect(DEFAULT_CONFIG.triageAllOpenIssues).toBe(true);
  });
});
