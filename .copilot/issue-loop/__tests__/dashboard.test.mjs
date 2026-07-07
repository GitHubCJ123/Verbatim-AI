import { describe, expect, it } from "vitest";
import {
  applyApproval,
  startAction,
  finishAction,
  buildPhaseView,
  demoIssue,
  markDownstreamNeedsRedo,
  PHASES,
  recordFeedback,
  recordReflection,
  assertTextOnlyAgentCommand,
} from "../lib/dashboard.mjs";

describe("dashboard state", () => {
  it("keeps demo issue local and non-numeric", () => {
    expect(demoIssue().id).toBe("demo-9001");
    expect(String(demoIssue().number)).toContain("DEMO");
  });

  it("approves a phase and makes the next phase ready", () => {
    const state = { issues: {} };
    applyApproval(state, "demo-9001", "requirements", { approver: "tester" });

    expect(state.issues["demo-9001"].overrides.requirements).toBe("approved");
    expect(state.issues["demo-9001"].overrides.spec).toBe("ready");
    expect(state.issues["demo-9001"].overrides["adversarial-review"]).toBe("needs-redo");
  });

  it("records feedback and reflection locally", () => {
    const state = { issues: {} };
    recordFeedback(state, "demo-9001", "spec", "make it clearer", "agent output");
    recordReflection(state, "demo-9001", "improve reviewer prompt");

    expect(state.issues["demo-9001"].feedback[0].feedback).toContain("clearer");
    expect(state.issues["demo-9001"].reflections[0].result).toContain("reviewer");
    expect(state.issues["demo-9001"].overrides["adversarial-review"]).toBe("needs-redo");
  });

  it("tracks running actions so polling can show live state", () => {
    const state = { issues: {} };
    const action = startAction(state, "demo-9001", "spec", "feedback-agent", "Running");
    let phases = buildPhaseView(demoIssue(), state.issues["demo-9001"], {});
    expect(phases.find((phase) => phase.id === "spec").status).toBe("running");

    finishAction(state, "demo-9001", action.id, "complete", "Done");
    phases = buildPhaseView(demoIssue(), state.issues["demo-9001"], {});
    expect(phases.find((phase) => phase.id === "spec").status).not.toBe("running");
  });

  it("builds all phases", () => {
    const phases = buildPhaseView(demoIssue(), {}, {});
    expect(phases.map((phase) => phase.id)).toEqual(PHASES.map((phase) => phase.id));
  });

  it("rejects agent commands that grant tools or repo access", () => {
    expect(() => assertTextOnlyAgentCommand("cat {promptFile}")).not.toThrow();
    expect(() => assertTextOnlyAgentCommand("copilot -p {promptFile} --add-dir .")).toThrow();
    expect(() => assertTextOnlyAgentCommand("copilot -p hello")).toThrow();
  });
});
