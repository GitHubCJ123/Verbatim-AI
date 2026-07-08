import fs from "node:fs/promises";
import path from "node:path";
import { spawnFile } from "./process.mjs";
import { slugify } from "./markers.mjs";

const DEFAULT_WORKTREE_ROOT = ".copilot-issue-loop/worktrees";

export async function git(args, cwd) {
  const result = await spawnFile("git", args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

export async function remoteBranchExists(repoCwd, branch) {
  const result = await spawnFile("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], {
    cwd: repoCwd,
  });
  return result.code === 0;
}

export async function ensureRuntimeDir(repoCwd) {
  const dir = path.join(repoCwd, ".copilot-issue-loop");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function changedFiles(cwd, base = "origin/main") {
  const out = await git(["diff", "--name-only", `${base}...HEAD`], cwd);
  return out.split("\n").filter(Boolean);
}

export function hasUiChanges(files) {
  return files.some((file) =>
    /^(src\/(routes|components|overlay|styles)\/|overlay\.html|src\/App\.tsx)/.test(file),
  );
}

export function worktreeRoot(repoCwd, config) {
  const configured = config?.worktrees?.root;
  const rel = typeof configured === "string" && configured.trim() ? configured : DEFAULT_WORKTREE_ROOT;
  if (path.isAbsolute(rel)) {
    throw new Error("worktrees.root must be a path relative to the repository root");
  }
  return assertPathInside(repoCwd, path.resolve(repoCwd, rel));
}

function sanitizeRunId(runId) {
  const cleaned = String(runId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return cleaned || "run";
}

export function safeWorktreeName(issue, runId) {
  const number = String(issue?.number ?? "0").replace(/[^0-9]/g, "") || "0";
  const slug = slugify(issue?.title ?? "issue", 36);
  return `issue-${number}-${slug}-${sanitizeRunId(runId)}`;
}

export function assertPathInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const rel = path.relative(resolvedParent, resolvedChild);
  if (rel === "") {
    throw new Error(`Path escapes parent boundary: ${resolvedChild} equals ${resolvedParent}`);
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes parent boundary: ${resolvedChild} is not inside ${resolvedParent}`);
  }
  return resolvedChild;
}

export function parseWorktreeListPorcelain(output) {
  const branches = new Set();
  const paths = new Set();
  const byBranch = new Map();
  let currentPath = null;
  for (const line of String(output ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      if (currentPath) paths.add(path.resolve(currentPath));
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      const branch = ref.replace(/^refs\/heads\//, "");
      if (branch) {
        branches.add(branch);
        if (currentPath) byBranch.set(branch, path.resolve(currentPath));
      }
    }
  }
  return { branches, paths, byBranch };
}

export async function listActiveWorktreeBranches(repoCwd) {
  const out = await git(["worktree", "list", "--porcelain"], repoCwd);
  return parseWorktreeListPorcelain(out);
}

export async function ensureAutomationWorktree({ repoCwd, config, issue, branch, runId }) {
  const baseBranch = config?.baseBranch ?? "main";
  const root = worktreeRoot(repoCwd, config);
  await fs.mkdir(root, { recursive: true });
  const name = safeWorktreeName(issue, runId);
  const worktreePath = assertPathInside(root, path.join(root, name));
  await git(["fetch", "origin", baseBranch, "--quiet"], repoCwd);
  await git(
    ["worktree", "add", "-B", branch, worktreePath, `origin/${baseBranch}`],
    repoCwd,
  );
  return { path: worktreePath, branch };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function removeAutomationWorktree({
  repoCwd,
  config,
  worktreePath,
  branch,
  removeBranch = true,
}) {
  const root = worktreeRoot(repoCwd, config);
  const resolved = assertPathInside(root, worktreePath);
  const removed = { worktreeRemoved: false, branchDeleted: false };
  if (await pathExists(resolved)) {
    await git(["worktree", "remove", "--force", resolved], repoCwd);
    removed.worktreeRemoved = true;
  }
  if (removeBranch && branch) {
    try {
      await git(["branch", "-d", branch], repoCwd);
      removed.branchDeleted = true;
    } catch {
      // branch may be absent or unmerged; -d intentionally refuses unmerged branches.
    }
  }
  return removed;
}

export async function cleanupMergedAutomationPr({
  repoCwd,
  config,
  pr,
  activeWorktrees = new Set(),
}) {
  if (!pr?.mergedAt) {
    return { cleaned: false, reason: "not-merged" };
  }
  const branch = pr.headRefName;
  const prefix = config?.branchPrefix ?? "";
  if (!prefix || !branch || !branch.startsWith(prefix)) {
    return { cleaned: false, reason: "not-automation-branch" };
  }
  const expectedOwner = String(config?.repository ?? "").split("/")[0];
  const prOwner = pr.headRepositoryOwner?.login;
  if (expectedOwner && prOwner && prOwner !== expectedOwner) {
    return { cleaned: false, reason: "owner-mismatch" };
  }
  const worktreePath = pr.automationWorktreePath;
  if (
    activeWorktrees.has(branch) ||
    (worktreePath && activeWorktrees.has(worktreePath))
  ) {
    return { cleaned: false, reason: "worktree-active" };
  }

  const actions = [];
  if (worktreePath) {
    const removed = await removeAutomationWorktree({
      repoCwd,
      config,
      worktreePath,
      branch,
      removeBranch: true,
    });
    if (removed.worktreeRemoved) actions.push("worktree");
    if (removed.branchDeleted) actions.push("local-branch");
  }
  if (await remoteBranchExists(repoCwd, branch)) {
    await git(["push", "origin", "--delete", branch], repoCwd);
    actions.push("remote-branch");
  }
  if (actions.length === 0) return { cleaned: false, reason: "already-cleaned" };
  return { cleaned: true, actions };
}
