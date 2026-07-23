import { describe, expect, it } from "vitest";
import {
  critiqueRequirements,
  isSecuritySensitiveIssue,
  issueInputSha,
  latestRequirementsMarker,
  requirementsMarker,
  requirementsReview,
} from "../lib/requirements.mjs";

describe("requirements critique", () => {
  it("marks issue 18 style reports clear enough for spec drafting", () => {
    const issue = {
      number: 18,
      title: "Issues installing 0.5.9 on Windows",
      body: "1. even though I selected to not create an account during setup, the default was Azure.\n2. when I selected Local - Whisper I got HTTP status client error (404 Not Found).",
      comments: [],
    };

    const critique = critiqueRequirements(issue);

    expect(critique.status).toBe("clear");
    expect(requirementsReview(issue, critique)).toContain("Status: clear");
  });

  it("marks underspecified issues as needing human input", () => {
    expect(
      critiqueRequirements({ number: 1, title: "Bug", body: "broken", comments: [] }).status,
    ).toBe("needs-human");
  });

  it("clears well-structured feature/design issues without demanding repro steps", () => {
    const issue = {
      number: 40,
      title: "Full multi-architecture model catalogue",
      labels: [{ name: "enhancement" }],
      body: "## Gap\nWe only run two engines today.\n\n## Proposed approach\n- Evaluate a GGUF multi-architecture engine as a sidecar so there is no in-process linking.\n\n## Non-goals\n- No in-process whisper.cpp linking.",
      comments: [],
    };
    const critique = critiqueRequirements(issue);
    expect(critique.status).toBe("clear");
    expect(critique.issueType).toBe("feature");
    expect(critique.questions.join(" ")).not.toMatch(/reproduction steps/i);
  });

  it("does not treat general engineering/security topics as security-sensitive", () => {
    const design = {
      number: 40,
      title: "sidecar engine",
      body: "Evaluate a sidecar engine with network access, exec of a runtime binary, and a release pipeline in CI.",
      comments: [],
    };
    expect(isSecuritySensitiveIssue(design)).toBe(false);
    const real = {
      number: 41,
      title: "harden",
      body: "We must store a bearer token and handle the private key / api key for auth.",
      comments: [],
    };
    expect(isSecuritySensitiveIssue(real)).toBe(true);
  });

  it("parses latest requirements markers", () => {
    const marker = requirementsMarker({
      issue: 18,
      status: "clear",
      issueInputSha: "abc",
      artifactSha: "def",
    });

    expect(latestRequirementsMarker([{ body: marker }])?.attrs).toMatchObject({
      issue: "18",
      status: "clear",
      issueInputSha: "abc",
    });
  });

  it("ignores automation marker comments in the issue input hash", () => {
    const issue = { number: 18, title: "Install bug", body: "HTTP status 404", comments: [] };
    const before = issueInputSha(issue);
    const marker = requirementsMarker({
      issue: 18,
      status: "clear",
      issueInputSha: before,
      artifactSha: "artifact",
    });

    expect(issueInputSha({ ...issue, comments: [{ body: marker }] })).toBe(before);
  });
});
