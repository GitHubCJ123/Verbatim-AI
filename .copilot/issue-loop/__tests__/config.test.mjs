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

  it("keeps initial issue triggers manual by default", () => {
    expect(DEFAULT_CONFIG.triageAllOpenIssues).toBe(false);
  });

  it("uses a local ignored worktree root by default", () => {
    expect(DEFAULT_CONFIG.worktrees.root).toBe(".copilot-issue-loop/worktrees");
    expect(DEFAULT_CONFIG.worktrees.cleanupMergedPrBranches).toBe(true);
  });

  it("bounds agent PR review iteration by default", () => {
    expect(DEFAULT_CONFIG.maxPrReviewIterations).toBe(2);
  });
});
