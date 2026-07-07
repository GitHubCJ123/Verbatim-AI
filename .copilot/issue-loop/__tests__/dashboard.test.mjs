import { describe, expect, it } from "vitest";
import {
  applyApproval,
  startAction,
  finishAction,
  buildPhaseView,
  markDownstreamNeedsRedo,
  PHASES,
  recordFeedback,
  recordReflection,
  assertTextOnlyAgentCommand,
} from "../lib/dashboard.mjs";

const issueFixture = {
  id: "gh-18",
  number: 18,
  title: "Issues installing 0.5.9 on Windows",
  body: "When I selected Local - Whisper I got HTTP status client error 404 for whisper-runtimes.json.",
  labels: ["bug"],
  source: "github",
};

describe("dashboard state", () => {
  it("approves a phase and makes the next phase ready", () => {
    const state = { issues: {} };
    applyApproval(state, "gh-18", "requirements", { approver: "tester" });

    expect(state.issues["gh-18"].overrides.requirements).toBe("approved");
    expect(state.issues["gh-18"].overrides.spec).toBe("ready");
    expect(state.issues["gh-18"].overrides["adversarial-review"]).toBe("needs-redo");
  });

  it("keeps GitHub spec approval local-only", () => {
    const state = { issues: {} };
    applyApproval(state, "gh-18", "approval", { approver: "tester" });

    expect(state.issues["gh-18"].overrides.approval).toBe("local-approved");
    expect(state.issues["gh-18"].overrides.implementation).toBeUndefined();
  });

  it("records feedback and reflection locally", () => {
    const state = { issues: {} };
    recordFeedback(state, "gh-18", "spec", "make it clearer", "agent output");
    recordReflection(state, "gh-18", "improve reviewer prompt");

    expect(state.issues["gh-18"].feedback[0].feedback).toContain("clearer");
    expect(state.issues["gh-18"].reflections[0].result).toContain("reviewer");
    expect(state.issues["gh-18"].overrides["adversarial-review"]).toBe("needs-redo");
  });

  it("tracks running actions so polling can show live state", () => {
    const state = { issues: {} };
    const action = startAction(state, "gh-18", "spec", "feedback-agent", "Running");
    let phases = buildPhaseView(issueFixture, state.issues["gh-18"], {});
    expect(phases.find((phase) => phase.id === "spec").status).toBe("running");

    finishAction(state, "gh-18", action.id, "complete", "Done");
    phases = buildPhaseView(issueFixture, state.issues["gh-18"], {});
    expect(phases.find((phase) => phase.id === "spec").status).not.toBe("running");
  });

  it("builds all phases", () => {
    const phases = buildPhaseView(issueFixture, {}, {});
    expect(phases.map((phase) => phase.id)).toEqual(PHASES.map((phase) => phase.id));
  });

  it("rejects agent commands that grant tools or repo access", () => {
    expect(() => assertTextOnlyAgentCommand("cat {promptFile}")).not.toThrow();
    expect(() => assertTextOnlyAgentCommand("copilot -p {promptFile} --add-dir .")).toThrow();
    expect(() => assertTextOnlyAgentCommand("copilot -p hello")).toThrow();
  });
});
