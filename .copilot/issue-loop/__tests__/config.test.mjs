import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, modelFamily, validateConfig, recoveryConfigErrors } from "../lib/config.mjs";

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

describe("recovery config validation (security)", () => {
  it("accepts the safe default recovery config", () => {
    expect(recoveryConfigErrors(DEFAULT_CONFIG.recovery)).toEqual([]);
  });

  it("rejects a roster model token that could smuggle a CLI flag", () => {
    const recovery = structuredClone(DEFAULT_CONFIG.recovery);
    recovery.rosters["spec-review"] = ["claude-opus-4.8", "--allow-tool=shell"];
    const errors = recoveryConfigErrors(recovery);
    expect(errors.some((e) => /unsafe model token/i.test(e))).toBe(true);
  });

  it("rejects model tokens with whitespace or a leading dash", () => {
    const recovery = structuredClone(DEFAULT_CONFIG.recovery);
    recovery.rosters.requirements = ["gpt-5.5", "-rf /etc"];
    recovery.rosters["spec-review"] = ["claude-opus-4.8", "gpt 5.5"];
    const errors = recoveryConfigErrors(recovery);
    expect(errors.filter((e) => /unsafe model token/i.test(e)).length).toBe(2);
  });

  it("still allows the literal auto model token", () => {
    const recovery = structuredClone(DEFAULT_CONFIG.recovery);
    recovery.rosters.implementation = ["auto", "claude-sonnet-5", "gpt-5.5"];
    expect(recoveryConfigErrors(recovery).some((e) => /unsafe model token/i.test(e))).toBe(false);
  });

  it("rejects an unsafe quorum that could wave a council through with no votes", () => {
    const recovery = structuredClone(DEFAULT_CONFIG.recovery);
    recovery.phases["spec-review"].quorum = 0;
    expect(recoveryConfigErrors(recovery).some((e) => /quorum/i.test(e))).toBe(true);
    recovery.phases["spec-review"].quorum = "majority";
    expect(recoveryConfigErrors(recovery).some((e) => /quorum/i.test(e))).toBe(false);
  });

  it("still forbids AI-downgrading a security-sensitive requirements issue", () => {
    const recovery = structuredClone(DEFAULT_CONFIG.recovery);
    recovery.phases.requirements.allowAiDowngradeForSecuritySensitive = true;
    expect(
      recoveryConfigErrors(recovery).some((e) => /allowAiDowngradeForSecuritySensitive/i.test(e)),
    ).toBe(true);
  });
});
