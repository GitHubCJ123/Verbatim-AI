import { describe, expect, it } from "vitest";
import {
  critiqueRequirements,
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
