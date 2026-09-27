import { describe, expect, it } from "vitest";
import { buildPhaseView, setPhaseStatus } from "../lib/dashboard.mjs";

const issueFixture = {
  id: "gh-77",
  number: 77,
  title: "Continue a human-gated phase",
  body: "",
  labels: ["bug"],
  source: "github",
};

describe("continue loop phase view", () => {
  it("marks needs-human and blocked phases as needing human input", () => {
    const phases = buildPhaseView(issueFixture, {}, {
      requirements: { status: "needs-human", output: "Maintainer decision required." },
      spec: { status: "blocked", output: "Waiting for requirements." },
      implementation: { status: "ready", output: "Ready to run." },
      verification: { status: "complete", output: "Done." },
    });

    expect(phases.find((phase) => phase.id === "requirements").needsHuman).toBe(true);
    expect(phases.find((phase) => phase.id === "spec").needsHuman).toBe(true);
    expect(phases.find((phase) => phase.id === "implementation").needsHuman).toBe(false);
    expect(phases.find((phase) => phase.id === "verification").needsHuman).toBe(false);
  });

  it("uses the latest transition message as the blocked reason", () => {
    const stateIssue = {
      overrides: {},
      approvals: {},
      feedback: [],
      reflections: [],
      events: [],
      transitions: [],
      activeActions: {},
    };
    setPhaseStatus(stateIssue, "spec", "blocked", { message: "Old blocker." });
    setPhaseStatus(stateIssue, "spec", "blocked", { message: "Need maintainer to choose the migration path." });

    const phase = buildPhaseView(issueFixture, stateIssue, {
      spec: { status: "ready", output: "Output fallback." },
    }).find((item) => item.id === "spec");

    expect(phase.blockedReason).toBe("Need maintainer to choose the migration path.");
  });

  it("falls back to the first output line and bounds blockedReason", () => {
    const longLine = `First line ${"x".repeat(500)}`;
    const phase = buildPhaseView(issueFixture, {}, {
      "adversarial-review": {
        status: "needs-human",
        output: `${longLine}\nSecond line should not be used.`,
      },
    }).find((item) => item.id === "adversarial-review");

    expect(phase.blockedReason).toBe(longLine.slice(0, 300));
    expect(phase.blockedReason).toHaveLength(300);
  });
});
