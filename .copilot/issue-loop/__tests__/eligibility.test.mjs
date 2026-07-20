import { describe, expect, it } from "vitest";
import { EVAL_CODES, eligibilitySummary, evaluateEligibility } from "../lib/eligibility.mjs";

const config = {
  requiredLabels: ["automate"],
  excludedLabels: ["wontfix", "blocked", "needs-human"],
};

const issue = {
  number: 13,
  title: "Dashboard says stuck",
  labels: ["automate"],
};

describe("evaluateEligibility", () => {
  it("marks an enrolled issue without blockers as eligible", () => {
    expect(evaluateEligibility({ config, issue })).toEqual({ eligible: true, reasons: [] });
  });

  it("explains a missing required label and names the label", () => {
    const result = evaluateEligibility({ config, issue: { ...issue, labels: [] } });

    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatchObject({ code: EVAL_CODES.MISSING_REQUIRED_LABEL });
    expect(result.reasons[0].message).toContain("`automate`");
    expect(result.reasons[0].message).toContain("add");
  });

  it("explains excluded labels", () => {
    const result = evaluateEligibility({ config, issue: { ...issue, labels: ["automate", "blocked"] } });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: EVAL_CODES.EXCLUDED_LABEL }));
  });

  it("explains an open linked PR", () => {
    const result = evaluateEligibility({
      config,
      issue,
      openPrs: [{ number: 41, state: "OPEN", closingIssuesReferences: [{ number: 13 }] }],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: EVAL_CODES.OPEN_LINKED_PR }));
  });

  it("explains active claims", () => {
    const result = evaluateEligibility({ config, issue, activeClaims: 2 });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: EVAL_CODES.ACTIVE_CLAIM }));
  });

  it("explains stop labels", () => {
    const result = evaluateEligibility({ config, issue, stopReason: "label automation-stop" });

    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatchObject({ code: EVAL_CODES.STOPPED });
  });

  it("combines multiple reasons in deterministic severity order", () => {
    const result = evaluateEligibility({
      config,
      issue: { ...issue, labels: ["blocked"] },
      openPrs: [{ number: 42, status: "open", relatedIssues: [13] }],
      remoteBranchExists: true,
      activeClaims: 1,
      stopReason: "label automation-stop",
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      EVAL_CODES.STOPPED,
      EVAL_CODES.MISSING_REQUIRED_LABEL,
      EVAL_CODES.EXCLUDED_LABEL,
      EVAL_CODES.OPEN_LINKED_PR,
      EVAL_CODES.REMOTE_BRANCH_EXISTS,
      EVAL_CODES.ACTIVE_CLAIM,
    ]);
  });

  it("summarizes eligibility results", () => {
    expect(eligibilitySummary(evaluateEligibility({ config, issue }))).toBe("Eligible");
    expect(eligibilitySummary(evaluateEligibility({ config, issue: { ...issue, labels: [] } }))).toMatch(
      /^Ineligible: Not enrolled:/,
    );
  });
});
