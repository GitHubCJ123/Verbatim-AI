import { describe, expect, it } from "vitest";
import {
  activeClaimsFromComments,
  claimMarker,
  issueBranchName,
  parseMarkers,
  specApprovalMarker,
  slugify,
} from "../lib/markers.mjs";

describe("automation markers", () => {
  it("parses marker attributes", () => {
    const markers = parseMarkers(
      '<!-- verbatim-ai:claim:v1 issue=3 run=abc branch="copilot/issue-3-demo" expires=2099-01-01T00:00:00.000Z -->',
    );

    expect(markers[0]).toMatchObject({
      kind: "claim",
      attrs: { issue: "3", run: "abc", branch: "copilot/issue-3-demo" },
    });
  });

  it("finds non-expired claims", () => {
    const body = claimMarker({
      issue: 3,
      runId: "run",
      branch: "copilot/issue-3-demo",
      expires: "2099-01-01T00:00:00.000Z",
    });

    expect(activeClaimsFromComments([{ body, author: { login: "octo" } }])).toHaveLength(1);
  });

  it("builds deterministic branch names", () => {
    expect(issueBranchName({ branchPrefix: "copilot/issue-" }, { number: 3, title: "Add skills!" }))
      .toBe("copilot/issue-3-add-skills");
    expect(slugify("")).toBe("issue");
  });

  it("binds spec approvals to path and hash", () => {
    const marker = specApprovalMarker({
      issue: 3,
      approver: "maintainer",
      path: "docs/automation/specs/issue-0003-demo/spec.md",
      sha: "abc123",
    });

    expect(parseMarkers(marker)[0].attrs).toMatchObject({
      issue: "3",
      path: "docs/automation/specs/issue-0003-demo/spec.md",
      sha: "abc123",
    });
  });
});
