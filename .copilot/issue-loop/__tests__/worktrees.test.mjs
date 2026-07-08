import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPathInside,
  cleanupMergedAutomationPr,
  parseWorktreeListPorcelain,
  safeWorktreeName,
  worktreeRoot,
} from "../lib/git.mjs";

const config = {
  baseBranch: "main",
  branchPrefix: "copilot/issue-",
  repository: "GitHubCJ123/Verbatim-AI",
};

describe("worktreeRoot", () => {
  it("defaults to .copilot-issue-loop/worktrees under repoCwd", () => {
    expect(worktreeRoot("/repo", config)).toBe(
      path.resolve("/repo", ".copilot-issue-loop/worktrees"),
    );
  });

  it("honors a configured worktree root", () => {
    const root = worktreeRoot("/repo", { worktrees: { root: "custom/wt" } });
    expect(root).toBe(path.resolve("/repo", "custom/wt"));
  });

  it("refuses absolute configured worktree roots", () => {
    expect(() => worktreeRoot("/repo", { worktrees: { root: "/tmp/outside" } })).toThrow(
      /relative to the repository root/,
    );
  });

  it("refuses configured worktree roots that escape the repo", () => {
    expect(() => worktreeRoot("/repo", { worktrees: { root: "../outside" } })).toThrow(
      /escapes parent boundary/,
    );
  });
});

describe("assertPathInside", () => {
  const parent = "/repo/.copilot-issue-loop/worktrees";

  it("returns the resolved child when nested", () => {
    expect(assertPathInside(parent, path.join(parent, "issue-1-x"))).toBe(
      path.resolve(parent, "issue-1-x"),
    );
  });

  it("refuses parent-directory traversal", () => {
    expect(() => assertPathInside(parent, path.join(parent, "..", "..", "escape"))).toThrow(
      /escapes parent boundary/,
    );
  });

  it("refuses absolute paths outside the parent", () => {
    expect(() => assertPathInside(parent, "/etc/passwd")).toThrow(/escapes parent boundary/);
  });

  it("refuses when child equals parent", () => {
    expect(() => assertPathInside(parent, parent)).toThrow(/escapes parent boundary/);
  });
});

describe("safeWorktreeName", () => {
  it("sanitizes a malicious issue title and runId into a filesystem-safe name", () => {
    const name = safeWorktreeName(
      { number: 42, title: "../../etc/passwd; rm -rf / #evil" },
      "../../../$(whoami)/run id",
    );
    expect(name.startsWith("issue-42-")).toBe(true);
    expect(name).not.toMatch(/[^a-z0-9-]/);
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
  });

  it("falls back to safe defaults for empty inputs", () => {
    const name = safeWorktreeName({ number: "", title: "" }, "");
    expect(name).toMatch(/^issue-0-issue-run$/);
  });

  it("strips non-numeric characters from the issue number", () => {
    const name = safeWorktreeName({ number: "7; DROP", title: "Add feature" }, "abc123");
    expect(name.startsWith("issue-7-")).toBe(true);
  });
});

describe("cleanupMergedAutomationPr preconditions", () => {
  const repoCwd = "/repo";

  it("refuses PRs that are not merged", async () => {
    const result = await cleanupMergedAutomationPr({
      repoCwd,
      config,
      pr: { mergedAt: null, headRefName: "copilot/issue-1-x" },
    });
    expect(result).toEqual({ cleaned: false, reason: "not-merged" });
  });

  it("refuses non-automation branches", async () => {
    const result = await cleanupMergedAutomationPr({
      repoCwd,
      config,
      pr: { mergedAt: "2026-01-01T00:00:00Z", headRefName: "feature/manual-change" },
    });
    expect(result).toEqual({ cleaned: false, reason: "not-automation-branch" });
  });

  it("refuses forks whose head repo owner differs", async () => {
    const result = await cleanupMergedAutomationPr({
      repoCwd,
      config,
      pr: {
        mergedAt: "2026-01-01T00:00:00Z",
        headRefName: "copilot/issue-1-x",
        headRepositoryOwner: { login: "attacker" },
      },
    });
    expect(result).toEqual({ cleaned: false, reason: "owner-mismatch" });
  });

  it("refuses to clean when a matching worktree is still active", async () => {
    const result = await cleanupMergedAutomationPr({
      repoCwd,
      config,
      pr: {
        mergedAt: "2026-01-01T00:00:00Z",
        headRefName: "copilot/issue-1-x",
        headRepositoryOwner: { login: "GitHubCJ123" },
      },
      activeWorktrees: new Set(["copilot/issue-1-x"]),
    });
    expect(result).toEqual({ cleaned: false, reason: "worktree-active" });
  });

  it("reports already-cleaned when merged automation PR has no local worktree and no remote branch", async () => {
    const result = await cleanupMergedAutomationPr({
      repoCwd,
      config,
      pr: {
        mergedAt: "2026-01-01T00:00:00Z",
        headRefName: "copilot/issue-1-x",
        headRepositoryOwner: { login: "GitHubCJ123" },
      },
    });
    expect(result).toEqual({ cleaned: false, reason: "already-cleaned" });
  });
});

describe("parseWorktreeListPorcelain", () => {
  it("extracts branch names and resolved paths from git worktree list --porcelain output", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.copilot-issue-loop/worktrees/issue-1-x",
      "HEAD def456",
      "branch refs/heads/copilot/issue-1-x",
      "",
    ].join("\n");
    const { branches, paths } = parseWorktreeListPorcelain(output);
    expect(branches.has("main")).toBe(true);
    expect(branches.has("copilot/issue-1-x")).toBe(true);
    expect(paths.has(path.resolve("/repo"))).toBe(true);
    expect(paths.has(path.resolve("/repo/.copilot-issue-loop/worktrees/issue-1-x"))).toBe(true);
    expect(parseWorktreeListPorcelain(output).byBranch.get("copilot/issue-1-x")).toBe(
      path.resolve("/repo/.copilot-issue-loop/worktrees/issue-1-x"),
    );
  });

  it("returns empty sets for empty or detached-only output", () => {
    const { branches, paths } = parseWorktreeListPorcelain("worktree /repo\nHEAD abc123\ndetached\n");
    expect(branches.size).toBe(0);
    expect(paths.size).toBe(1);
  });

  it("handles undefined/null input without throwing", () => {
    expect(parseWorktreeListPorcelain(undefined)).toEqual({
      branches: new Set(),
      paths: new Set(),
      byBranch: new Map(),
    });
    expect(parseWorktreeListPorcelain(null)).toEqual({
      branches: new Set(),
      paths: new Set(),
      byBranch: new Map(),
    });
  });
});
