import { describe, expect, it } from "vitest";
import {
  SPEC_GATE_POLICY_VERSION,
  buildGateRecord,
  securityVeto,
  specGateFingerprint,
  specGateIsFresh,
} from "../lib/spec-gate.mjs";
import { RESUME_ACTIONS, hasDurableAutomationState, reconcileIssue, recordedPrNumber } from "../lib/resume.mjs";

const fp = (over = {}) =>
  specGateFingerprint({ issueInputSha: "issue1", specSha: "spec1", reviewSha: "review1", ...over });

const summaryWithGate = (gate) => ({ phaseStatuses: { "spec-review": { status: "approved", details: { gate } } } });

describe("spec gate idempotency", () => {
  it("is stable for identical inputs and changes when any input changes", () => {
    expect(fp()).toBe(fp());
    expect(fp({ specSha: "spec2" })).not.toBe(fp());
    expect(fp({ reviewSha: "review2" })).not.toBe(fp());
    expect(fp({ issueInputSha: "issue2" })).not.toBe(fp());
    // bumping the policy version invalidates cached passes
    expect(fp({ policyVersion: `${SPEC_GATE_POLICY_VERSION}-next` })).not.toBe(fp());
  });

  it("requires every input to be present", () => {
    expect(specGateFingerprint({ issueInputSha: "a", specSha: "b", reviewSha: null })).toBeNull();
    expect(specGateFingerprint({ issueInputSha: "", specSha: "b", reviewSha: "c" })).toBeNull();
  });

  it("treats a passing gate as fresh only for the same fingerprint", () => {
    const summary = summaryWithGate(buildGateRecord({ passed: true, fingerprint: fp(), decision: "proceed" }));
    expect(specGateIsFresh(summary, fp())).toBe(true);
    // a re-drafted spec produces a different fingerprint -> must re-review
    expect(specGateIsFresh(summary, fp({ specSha: "spec2" }))).toBe(false);
    expect(specGateIsFresh(summary, null)).toBe(false);
  });

  it("never treats a failed gate as fresh", () => {
    const summary = summaryWithGate(buildGateRecord({ passed: false, fingerprint: fp(), decision: "needs-human" }));
    expect(specGateIsFresh(summary, fp())).toBe(false);
  });

  it("surfaces a hard security veto that ordinary approval must not clear", () => {
    const summary = summaryWithGate(
      buildGateRecord({ passed: false, fingerprint: fp(), decision: "needs-human", securityVeto: true, vetoReason: "secret handling" }),
    );
    const veto = securityVeto(summary);
    expect(veto.active).toBe(true);
    expect(veto.reason).toContain("secret handling");
    expect(securityVeto(summaryWithGate(buildGateRecord({ passed: true, fingerprint: fp() }))).active).toBe(false);
    expect(securityVeto({}).active).toBe(false);
  });
});

describe("resume reconciliation", () => {
  const withState = (phaseStatuses) => ({ phaseStatuses, artifacts: [{ displayId: "SPEC-001" }] });

  it("starts a fresh run when there is no durable state", () => {
    expect(hasDurableAutomationState({})).toBe(false);
    expect(reconcileIssue({ summary: {} }).action).toBe(RESUME_ACTIONS.START);
    // artifacts without statuses is not durable state either
    expect(hasDurableAutomationState({ artifacts: [{ displayId: "X" }] })).toBe(false);
  });

  it("resumes an interrupted run that already owns downstream work", () => {
    // This is the case eligibility used to reject (its own branch/PR made it
    // ineligible), which stranded the issue forever.
    const decision = reconcileIssue({ summary: withState({ implementation: { status: "running" } }) });
    expect(decision.action).toBe(RESUME_ACTIONS.RESUME);
  });

  it("resumes when only spec-stage state exists", () => {
    expect(reconcileIssue({ summary: withState({ spec: { status: "complete" } }) }).action).toBe(RESUME_ACTIONS.RESUME);
  });

  it("skips when the run is terminal (handed to a human) or stopped or unenrolled", () => {
    expect(reconcileIssue({ summary: withState({ finalization: { status: "complete" } }) }).action).toBe(RESUME_ACTIONS.SKIP);
    expect(reconcileIssue({ summary: withState({ implementation: { status: "running" } }), stopReason: "label stop" }).action).toBe(RESUME_ACTIONS.SKIP);
    expect(reconcileIssue({ summary: withState({ implementation: { status: "running" } }), enrolled: false }).action).toBe(RESUME_ACTIONS.SKIP);
  });

  it("honors excluded labels on a RESUME (the human kill-switch must not be resume-exempt)", () => {
    const summary = withState({ implementation: { status: "running" } });
    const decision = reconcileIssue({
      summary,
      labels: ["automate", "needs-human"],
      excludedLabels: ["wontfix", "blocked", "needs-human"],
    });
    expect(decision.action).toBe(RESUME_ACTIONS.SKIP);
    expect(decision.reason).toContain("needs-human");
    // case-insensitive
    expect(reconcileIssue({ summary, labels: ["WontFix"], excludedLabels: ["wontfix"] }).action).toBe(RESUME_ACTIONS.SKIP);
  });

  it("never restarts implementation once a draft PR exists (would clobber the worktree and livelock)", () => {
    const summary = withState({ implementation: { status: "blocked", details: { prNumber: 42 } } });
    const decision = reconcileIssue({ summary });
    expect(decision.action).toBe(RESUME_ACTIONS.SKIP);
    expect(decision.reason).toContain("#42");
    expect(recordedPrNumber(summary)).toBe(42);
    expect(recordedPrNumber(withState({ implementation: { status: "running" } }))).toBeNull();
  });
});
