#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, stopRequested } from "./lib/config.mjs";
import {
  activeClaimsFromComments,
  claimMarker,
  issueBranchName,
  issueFolderName,
  specMarker,
  parseMarkers,
} from "./lib/markers.mjs";
import {
  collaboratorPermission,
  commentIssue,
  commentPR,
  getIssue,
  gh,
  hasWritePermission,
  issueComments,
  listMergedAutomationPRs,
  listOpenIssues,
  listOpenPRs,
} from "./lib/github.mjs";
import {
  cleanupMergedAutomationPr,
  ensureAutomationWorktree,
  ensureRuntimeDir,
  git,
  listActiveWorktreeBranches,
  remoteBranchExists,
} from "./lib/git.mjs";
import {
  adversarialPrompt,
  assertArchitectReviewerDiversity,
  architectPrompt,
  implementerPrompt,
  prReviewPrompt,
  runCopilot,
} from "./lib/copilot.mjs";
import {
  critiqueRequirements,
  latestRequirementsMarker,
  requirementsMarker,
  requirementsReview,
} from "./lib/requirements.mjs";
import {
  recordArtifact,
  readIssueAutomationSummary,
  setDurablePhaseStatus,
} from "./lib/artifacts.mjs";
import { readDashboardApproval } from "./lib/dashboard.mjs";
import { evaluateSpecReview } from "./lib/spec-review.mjs";
import { runVerification, verificationComment } from "./lib/verifier.mjs";
import { findSecretLikeText, redactSecrets, truncateForComment } from "./lib/redaction.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config ?? path.join(ROOT, ".copilot/issue-loop/config.example.json");
  const config = await loadConfig(configPath);
  assertArchitectReviewerDiversity(config);
  await ensureRuntimeDir(ROOT);

  if (!config.enabled) {
    console.log("Issue loop is disabled. Copy config.example.json to config.local.json and set enabled=true to run it.");
    return;
  }
  config.dryRun = config.dryRun || args.dryRun;

  if (config.dryRun) {
    console.log("Issue loop is in dry-run mode; no GitHub or git write actions will be taken.");
  }

  if (args.watch) {
    while (true) {
      await tick(config, args);
      await sleep(config.pollIntervalSeconds * 1000);
    }
  } else {
    await tick(config, args);
  }
}

async function tick(config, args) {
  const stopped = await stopRequested(config, ROOT);
  if (stopped) {
    console.log(`Stop requested by ${stopped}.`);
    return;
  }

  await preflight(config);
  const [issues, prs] = await Promise.all([listOpenIssues(config), listOpenPRs(config)]);
  const selected = [];
  for (const issue of issues) {
    if (config.triageAllOpenIssues && canRequirementsTriage(config, issue)) {
      await maybeProcessRequirementsOnly(config, issue);
    }
    if (selected.length >= config.maxIssuesPerTick) break;
    if (await isEligible(config, issue, prs)) selected.push(issue);
  }

  if (selected.length === 0) {
    console.log("No eligible issues.");
  } else {
    for (const issue of selected) {
      await processIssue(config, issue, args);
    }
  }

  await runCleanupPhase(config, args);
}

async function runCleanupPhase(config, args) {
  if (config.worktrees?.cleanupMergedPrBranches === false) return;
  if (config.dryRun || args.dryRun) {
    console.log("[dry-run] would check merged automation PRs for worktree/branch cleanup.");
    return;
  }
  let mergedPrs;
  try {
    mergedPrs = await listMergedAutomationPRs(config);
  } catch (error) {
    console.warn(`Cleanup phase could not list merged PRs: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const worktrees = await listActiveWorktreeBranches(ROOT).catch(() => ({
    branches: new Set(),
    paths: new Set(),
    byBranch: new Map(),
  }));
  const activePhaseWorktrees = await activeAutomationPhaseWorktrees(ROOT);
  for (const pr of mergedPrs ?? []) {
    let result;
    try {
      result = await cleanupMergedAutomationPr({
        repoCwd: ROOT,
        config,
        pr: {
          ...pr,
          automationWorktreePath: worktrees.byBranch.get(pr.headRefName),
        },
        activeWorktrees: activePhaseWorktrees,
      });
    } catch (error) {
      console.warn(`Cleanup failed for PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!result.cleaned) continue;
    console.log(`Cleaned up merged automation branch ${pr.headRefName} (PR #${pr.number}).`);
    const issueNumber = pr.closingIssuesReferences?.[0]?.number;
    if (issueNumber) {
      await recordCleanupArtifact(config, issueNumber, pr, result).catch((error) => {
        console.warn(`Could not record cleanup artifact for PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}

async function activeAutomationPhaseWorktrees(root) {
  const active = new Set();
  const specsDir = path.join(root, "docs/automation/specs");
  let issueDirs = [];
  try {
    issueDirs = await fs.readdir(specsDir, { withFileTypes: true });
  } catch {
    return active;
  }
  for (const entry of issueDirs) {
    if (!entry.isDirectory()) continue;
    const summaryFile = path.join(specsDir, entry.name, "artifacts", "summary.json");
    try {
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8"));
      for (const phase of Object.values(summary.phaseStatuses ?? {})) {
        if (phase?.status !== "running") continue;
        const details = phase.details ?? {};
        for (const key of ["branch", "worktreePath"]) {
          if (details[key]) active.add(details[key]);
        }
      }
    } catch {
      // Ignore missing/corrupt summaries; cleanup stays conservative through helper checks.
    }
  }
  return active;
}

async function recordCleanupArtifact(config, issueNumber, pr, result) {
  const issue = (await getIssue(config, issueNumber).catch(() => null)) ?? { number: issueNumber, title: "" };
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "cleanup",
    agent: "cleanup",
    title: `Cleanup complete for PR #${pr.number}`,
    summary: `Removed automation worktree/branch for merged PR #${pr.number} (${pr.headRefName}).`,
    body: `Actions: ${(result.actions ?? []).join(", ") || "none"}`,
    runId: issueRunId(issue),
    status: "complete",
    decision: "done",
    metadata: { prNumber: pr.number, branch: pr.headRefName, actions: result.actions ?? [] },
  });
}

async function preflight(config) {
  await gh(["auth", "status"]);
  if (config.reviewers.length === 0 && config.teamReviewers.length === 0) {
    if (config.dryRun) {
      console.warn("No reviewers configured; enabled runs will fail closed before finalization.");
      return;
    }
    throw new Error("No reviewers configured; finalizer must fail closed.");
  }
}

async function isEligible(config, issue, prs) {
  const labels = issue.labels.map((label) => label.name);
  const stopped = await stopRequested(config, ROOT, labels);
  if (stopped) return false;
  if (!config.requiredLabels.every((label) => labels.includes(label))) return false;
  if (labels.some((label) => config.excludedLabels.includes(label))) return false;
  if (prs.some((pr) => pr.closingIssuesReferences?.some((ref) => ref.number === issue.number))) {
    return false;
  }
  if (await remoteBranchExists(ROOT, issueBranchName(config, issue))) return false;
  const comments = issue.comments ?? (await issueComments(config, issue.number));
  if (activeClaimsFromComments(comments).length > 0) return false;
  return true;
}

function canRequirementsTriage(config, issue) {
  const labels = issue.labels.map((label) => label.name);
  if (labels.some((label) => config.excludedLabels.includes(label))) return false;
  if (labels.some((label) => config.stop?.labels?.includes(label))) return false;
  return true;
}

async function processIssue(config, issue, args) {
  const branch = issueBranchName(config, issue);
  const runId = issueRunId(issue);
  const specDir = path.join(ROOT, "docs/automation/specs", issueFolderName(issue));
  const specPath = path.join(specDir, "spec.md");
  console.log(`Selected issue #${issue.number}: ${issue.title}`);
  console.log(`Spec path: ${path.relative(ROOT, specPath)}`);

  const critique = critiqueRequirements(issue);
  const requirementsApproval = await readDashboardApproval(ROOT, issue, "requirements", {
    issueInputSha: critique.issueInputSha,
  });
  await writeRequirementsArtifact(config, issue, specDir, critique, runId);
  if (critique.status === "needs-human" && !requirementsApproval) {
    await maybeCommentRequirements(config, issue, critique);
    await setDurablePhaseStatus(ROOT, issue, "requirements", "needs-human", {
      issueInputSha: critique.issueInputSha,
      reason: critique.summary,
    });
    return;
  }
  if (critique.status === "needs-human" && requirementsApproval) {
    await setDurablePhaseStatus(ROOT, issue, "requirements", "approved", {
      issueInputSha: critique.issueInputSha,
      approvalId: requirementsApproval.id,
      reason: "Local dashboard requirements approval allows spec drafting.",
    });
  }

  const review = await writeSpecAndReview(
    config,
    issue,
    specDir,
    specPath,
    critique,
    args,
    runId,
    requirementsApproval?.note ?? "",
  );
  await maybeCommentRequirements(config, issue, critique, path.join(specDir, "requirements-review.md"));
  await maybeClaim(config, issue, branch);

  if (review && config.gates.requireHumanOnSpecReviewQuestions !== false && specReviewNeedsHuman(review)) {
      await maybeComment(
        config,
        issue.number,
        `${specMarker({
          issue: issue.number,
          status: "needs-human",
          path: path.relative(ROOT, specPath),
          sha: await fileSha256(specPath),
        })}\n\nSpec review raised open questions that require maintainer input before implementation.\n\n${review.slice(0, 6000)}`,
      );
      await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
        reason: "Spec review raised questions requiring human input.",
      });
      return;
  }

  await setDurablePhaseStatus(ROOT, issue, "implementation", "ready", {
    branch,
    reason: "Requirements and spec review gates passed. Implementation should run in an isolated worktree.",
  });
  if (config.dryRun || args.dryRun) {
    console.log("[dry-run] Requirements/spec review gates passed. Implementation phase would run in an isolated worktree.");
    return;
  }
  await runPostSpecPhases(config, issue, {
    branch,
    specDir,
    specPath,
    reviewPath: path.join(specDir, "adversarial-review.md"),
    runId,
  });
}

async function maybeProcessRequirementsOnly(config, issue) {
  const critique = critiqueRequirements(issue);
  const specDir = path.join(ROOT, "docs/automation/specs", issueFolderName(issue));
  await writeRequirementsArtifact(config, issue, specDir, critique, issueRunId(issue));
  await maybeCommentRequirements(
    config,
    issue,
    critique,
    critique.status === "clear" ? path.join(specDir, "requirements-review.md") : null,
  );
}

async function writeSpecAndReview(config, issue, specDir, specPath, critique, args, runId, approvalNote = "") {
  await writeSpecScaffold(config, issue, specDir);
  if (config.dryRun || args.dryRun) {
    console.log(`[dry-run] would run architect and adversarial reviewer for issue #${issue.number}`);
    return "";
  }
  await writeArchitectSpec(config, issue, specPath, runId, approvalNote);
  const reviewPath = path.join(specDir, "adversarial-review.md");
  return writeAdversarialReview(config, issue, specPath, reviewPath, runId);
}

async function writeSpecScaffold(config, issue, specDir) {
  if (config.dryRun) {
    console.log(`[dry-run] would write spec scaffold in ${path.relative(ROOT, specDir)}`);
    return;
  }
  await fs.mkdir(path.join(specDir, "screenshots/before"), { recursive: true });
  await fs.mkdir(path.join(specDir, "screenshots/after"), { recursive: true });
  await writeIfMissing(path.join(specDir, "spec.md"), specTemplate(issue));
  await writeIfMissing(path.join(specDir, "adversarial-review.md"), "# Adversarial review\n\nPending.\n");
  await writeIfMissing(path.join(specDir, "test-plan.md"), "# Test plan\n\nPending.\n");
  await writeIfMissing(path.join(specDir, "security-notes.md"), "# Security notes\n\nPending.\n");
  await writeIfMissing(path.join(specDir, "ux-evidence.md"), "# UX evidence\n\nPending.\n");
}

async function writeRequirementsArtifact(config, issue, specDir, critique, runId) {
  if (config.dryRun) {
    console.log(`[dry-run] would write requirements artifact in ${path.relative(ROOT, specDir)}`);
    return;
  }
  await fs.mkdir(specDir, { recursive: true });
  const body = requirementsReview(issue, critique);
  const reviewPath = path.join(specDir, "requirements-review.md");
  await fs.writeFile(reviewPath, body);
  const existing = await readIssueAutomationSummary(ROOT, issue);
  const current = existing.latestArtifacts?.requirements;
  if (current?.metadata?.issueInputSha === critique.issueInputSha && current?.metadata?.status === critique.status) {
    await setDurablePhaseStatus(ROOT, issue, "requirements", critique.status === "clear" ? "complete" : "needs-human", {
      issueInputSha: critique.issueInputSha,
      reason: critique.summary,
    });
    return;
  }
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "requirements",
    agent: "requirements-critic",
    title: "Requirements critique",
    summary: critique.summary,
    body,
    runId,
    status: critique.status === "clear" ? "complete" : "needs-human",
    decision: critique.status,
    metadata: {
      issueInputSha: critique.issueInputSha,
      status: critique.status,
      questions: critique.questions,
      findings: critique.findings,
    },
  });
}

async function writeArchitectSpec(config, issue, specPath, runId, approvalNote = "") {
  const result = await runCopilot(config, {
    role: "architect",
    worktree: ROOT,
    prompt: architectPrompt(issue, path.relative(ROOT, specPath), approvalNote),
  });
  if (result.code !== 0) throw new Error(result.stderr);
  const spec = normalizeAgentMarkdown(result.stdout, "Spec");
  await fs.writeFile(specPath, spec);
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "spec",
    agent: "architect",
    title: "Architect spec",
    summary: firstMeaningfulLine(spec),
    body: spec,
    runId,
    status: "complete",
    decision: "proceed",
    metadata: {
      specPath: path.relative(ROOT, specPath),
      specSha: await fileSha256(specPath),
    },
  });
}

async function writeAdversarialReview(config, issue, specPath, reviewPath, runId) {
  const specContent = await fs.readFile(specPath, "utf8");
  const result = await runCopilot(config, {
    role: "adversarialReviewer",
    worktree: ROOT,
    prompt: adversarialPrompt(issue, path.relative(ROOT, specPath), specContent),
  });
  if (result.code !== 0) throw new Error(result.stderr);
  const review = normalizeAgentMarkdown(result.stdout, "Adversarial review");
  await fs.writeFile(reviewPath, review);
  const decision = evaluateSpecReview(review);
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "adversarial-review",
    agent: "adversarial-reviewer",
    title: "Adversarial review",
    summary: decision.reason,
    body: review,
    runId,
    status: decision.needsHuman ? "needs-human" : "complete",
    decision: decision.decision,
    metadata: {
      reviewPath: path.relative(ROOT, reviewPath),
      reviewSha: await fileSha256(reviewPath),
      specPath: path.relative(ROOT, specPath),
      specSha: await fileSha256(specPath),
    },
  });
  return review;
}

async function runPostSpecPhases(config, issue, { branch, specDir, specPath, reviewPath, runId }) {
  const implementation = await runImplementationPhase(config, issue, {
    branch,
    specDir,
    specPath,
    reviewPath,
    runId,
  });
  if (!implementation?.pr) return;

  const maxIterations = config.maxPrReviewIterations ?? 2;
  let prReview = null;
  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    prReview = await runAgentPrReviewPhase(config, issue, {
      pr: implementation.pr,
      worktreePath: implementation.worktreePath,
      specPath,
      runId,
      attempt,
    });
    if (prReview?.decision === "approved") break;
    if (!prReview || attempt === maxIterations) break;
    const revision = await runImplementationRevisionPhase(config, issue, {
      pr: implementation.pr,
      branch,
      worktreePath: implementation.worktreePath,
      specPath,
      reviewPath,
      reviewFeedback: prReview.body,
      runId,
      attempt,
    });
    if (!revision) return;
    implementation.headSha = revision.headSha;
    implementation.pr = { ...implementation.pr, headRefOid: revision.headSha };
  }
  if (prReview?.decision !== "approved") {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      prNumber: implementation.pr.number,
      reason: `Agent PR review did not approve after ${maxIterations} attempt(s). Human feedback or manual intervention is required.`,
    });
    return;
  }

  const verification = await runVerificationPhase(config, issue, {
    pr: implementation.pr,
    worktreePath: implementation.worktreePath,
    runId,
  });
  if (!verification?.ok) return;

  await runFinalizationPhase(config, issue, {
    pr: implementation.pr,
    worktreePath: implementation.worktreePath,
    specDir,
    runId,
    verification,
  });
}

async function runImplementationPhase(config, issue, { branch, specDir, specPath, reviewPath, runId }) {
  await setDurablePhaseStatus(ROOT, issue, "implementation", "running", {
    branch,
    reason: "Creating isolated implementation worktree.",
  });
  const worktree = await ensureAutomationWorktree({ repoCwd: ROOT, config, issue, branch, runId });
  await setDurablePhaseStatus(ROOT, issue, "implementation", "running", {
    branch,
    worktreePath: worktree.path,
    reason: "Running implementer agent in isolated worktree.",
  });
  const specContent = await fs.readFile(specPath, "utf8");
  const reviewContent = await fs.readFile(reviewPath, "utf8").catch(() => "");
  const result = await runCopilot(config, {
    role: "implementer",
    worktree: worktree.path,
    prompt: implementerPrompt(issue, path.relative(worktree.path, specPath), specContent, reviewContent),
  });
  if (result.code !== 0) {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      reason: truncateForComment(result.stderr, 1000),
      branch,
      worktreePath: worktree.path,
    });
    return null;
  }

  const decision = parseDecisionLine(result.stdout, "IMPLEMENTATION_DECISION", ["ready", "blocked"]);
  if (decision !== "ready") {
    await recordArtifact({
      root: ROOT,
      issue,
      phase: "implementation",
      agent: "implementer",
      title: "Implementation blocked",
      summary: "Implementer reported that the spec could not be implemented safely.",
      body: result.stdout,
      runId,
      status: "blocked",
      decision: decision ?? "blocked",
      metadata: { branch, worktreePath: worktree.path },
    });
    return null;
  }

  await git(["add", "-A"], worktree.path);
  const stagedFiles = await git(["diff", "--cached", "--name-only"], worktree.path);
  if (!stagedFiles.trim()) {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      reason: "Implementer completed without file changes.",
      branch,
      worktreePath: worktree.path,
    });
    return null;
  }

  const diff = await git(["diff", "--cached"], worktree.path);
  const secretFindings = findSecretLikeText(diff);
  if (secretFindings.length) {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      reason: "Secret-like text found in implementation diff.",
      branch,
      worktreePath: worktree.path,
      findings: secretFindings,
    });
    return null;
  }

  await git(["diff", "--cached", "--check"], worktree.path);
  await git(
    [
      "commit",
      "-m",
      `Implement issue #${issue.number} automation spec`,
      "-m",
      "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    ],
    worktree.path,
  );
  await git(["push", "-u", "origin", branch], worktree.path);
  const headSha = (await git(["rev-parse", "HEAD"], worktree.path)).trim();
  const pr = await createDraftPr(config, issue, {
    branch,
    specPath,
    worktreePath: worktree.path,
    headSha,
  });
  const files = stagedFiles
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  await recordArtifact({
    root: ROOT,
    issue,
    phase: "implementation",
    agent: "implementer",
    title: `Draft PR #${pr.number}`,
    summary: `Opened draft PR #${pr.number} from ${branch}.`,
    body: [
      `PR: ${pr.url}`,
      `Branch: ${branch}`,
      `Head SHA: ${headSha}`,
      "",
      "Changed files:",
      ...files.map((file) => `- ${file}`),
      "",
      "Agent summary:",
      result.stdout,
    ].join("\n"),
    runId,
    status: "complete",
    decision: "proceed",
    metadata: {
      prNumber: pr.number,
      prUrl: pr.url,
      branch,
      headSha,
      worktreePath: worktree.path,
      changedFiles: files,
    },
  });
  await setDurablePhaseStatus(ROOT, issue, "agent-pr-review", "ready", {
    prNumber: pr.number,
    headSha,
  });
  return { pr, worktreePath: worktree.path, headSha };
}

async function runImplementationRevisionPhase(
  config,
  issue,
  { pr, branch, worktreePath, specPath, reviewPath, reviewFeedback, runId, attempt },
) {
  await setDurablePhaseStatus(ROOT, issue, "implementation", "running", {
    prNumber: pr.number,
    attempt,
    reason: "Applying agent PR review feedback in the existing isolated worktree.",
  });
  const specContent = await fs.readFile(specPath, "utf8");
  const reviewContent = [
    await fs.readFile(reviewPath, "utf8").catch(() => ""),
    "",
    "Agent PR review feedback:",
    reviewFeedback ?? "",
  ].join("\n");
  const result = await runCopilot(config, {
    role: "implementer",
    worktree: worktreePath,
    prompt: implementerPrompt(issue, path.relative(worktreePath, specPath), specContent, reviewContent),
  });
  if (result.code !== 0) {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      reason: truncateForComment(result.stderr, 1000),
      prNumber: pr.number,
      branch,
      worktreePath,
    });
    return null;
  }
  const decision = parseDecisionLine(result.stdout, "IMPLEMENTATION_DECISION", ["ready", "blocked"]);
  if (decision !== "ready") {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      reason: "Implementer could not address agent PR review feedback.",
      prNumber: pr.number,
      branch,
      worktreePath,
    });
    return null;
  }

  await git(["add", "-A"], worktreePath);
  const stagedFiles = await git(["diff", "--cached", "--name-only"], worktreePath);
  if (!stagedFiles.trim()) {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      reason: "Implementer reported ready but produced no revision changes.",
      prNumber: pr.number,
      branch,
      worktreePath,
    });
    return null;
  }
  const diff = await git(["diff", "--cached"], worktreePath);
  const secretFindings = findSecretLikeText(diff);
  if (secretFindings.length) {
    await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
      reason: "Secret-like text found in revision diff.",
      prNumber: pr.number,
      branch,
      worktreePath,
      findings: secretFindings,
    });
    return null;
  }
  await git(["diff", "--cached", "--check"], worktreePath);
  await git(
    [
      "commit",
      "-m",
      `Address agent PR review for issue #${issue.number}`,
      "-m",
      "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    ],
    worktreePath,
  );
  await git(["push", "origin", branch], worktreePath);
  const headSha = (await git(["rev-parse", "HEAD"], worktreePath)).trim();
  const files = stagedFiles
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "implementation",
    agent: "implementer",
    title: `Revision for PR #${pr.number}`,
    summary: `Pushed revision ${headSha} addressing agent PR review feedback.`,
    body: [
      `PR: ${pr.url}`,
      `Branch: ${branch}`,
      `Head SHA: ${headSha}`,
      "",
      "Changed files:",
      ...files.map((file) => `- ${file}`),
      "",
      "Agent summary:",
      result.stdout,
    ].join("\n"),
    runId,
    status: "complete",
    decision: "proceed",
    metadata: {
      prNumber: pr.number,
      prUrl: pr.url,
      branch,
      headSha,
      worktreePath,
      changedFiles: files,
      attempt,
    },
  });
  await setDurablePhaseStatus(ROOT, issue, "agent-pr-review", "ready", {
    prNumber: pr.number,
    headSha,
    reason: "Implementation revision pushed; agent PR review should re-run.",
  });
  return { headSha };
}

async function createDraftPr(config, issue, { branch, specPath, worktreePath, headSha }) {
  const title = `Implement issue #${issue.number}: ${issue.title}`;
  const body = [
    `Closes #${issue.number}`,
    "",
    "Automation draft PR.",
    "",
    `Spec: ${path.relative(ROOT, specPath)}`,
    `Head SHA: ${headSha}`,
    "",
    "This PR must pass agent PR review, verification, and human review before merge.",
  ].join("\n");
  const out = await gh(
    [
      "pr",
      "create",
      "--repo",
      config.repository,
      "--draft",
      "--base",
      config.baseBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd: worktreePath },
  );
  const url = out.trim().split(/\s+/).find((item) => /^https?:\/\//.test(item)) ?? out.trim();
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  if (!Number.isFinite(number)) {
    throw new Error(`Could not parse PR number from gh output: ${out}`);
  }
  return {
    number,
    title,
    url,
    isDraft: true,
    headRefName: branch,
    headRefOid: headSha,
    closingIssuesReferences: [{ number: issue.number }],
  };
}

async function runAgentPrReviewPhase(config, issue, { pr, worktreePath, specPath, runId, attempt = 1 }) {
  await setDurablePhaseStatus(ROOT, issue, "agent-pr-review", "running", {
    prNumber: pr.number,
    worktreePath,
    reason: "Agent reviewer is reviewing the implementation diff.",
  });
  const specContent = await fs.readFile(specPath, "utf8");
  const diff = await git(["diff", `${config.baseBranch ? `origin/${config.baseBranch}` : "origin/main"}...HEAD`], worktreePath);
  const result = await runCopilot(config, {
    role: "agentPrReviewer",
    worktree: worktreePath,
    prompt: prReviewPrompt(issue, pr, diff, specContent),
  });
  if (result.code !== 0) {
    await setDurablePhaseStatus(ROOT, issue, "agent-pr-review", "blocked", {
      reason: truncateForComment(result.stderr, 1000),
      prNumber: pr.number,
    });
    return null;
  }
  const decision = parseDecisionLine(result.stdout, "PR_REVIEW_DECISION", ["approved", "needs-changes"]);
  const approved = decision === "approved";
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "agent-pr-review",
    agent: "agent-pr-reviewer",
    title: approved ? "Agent PR review approved" : "Agent PR review requested changes",
    summary: approved
      ? "Agent PR review found no blocking findings."
      : `Agent PR review found blockers on attempt ${attempt}.`,
    body: result.stdout,
    runId,
    status: approved ? "complete" : "needs-redo",
    decision: decision ?? "needs-changes",
    metadata: {
      prNumber: pr.number,
      headSha: pr.headRefOid,
      attempt,
    },
  });
  await setDurablePhaseStatus(ROOT, issue, approved ? "verification" : "implementation", approved ? "ready" : "needs-redo", {
    prNumber: pr.number,
    reason: approved ? "Agent PR review approved." : "Agent PR review requested implementation changes.",
  });
  return { decision: decision ?? "needs-changes", body: result.stdout };
}

async function runVerificationPhase(config, issue, { pr, worktreePath, runId }) {
  await setDurablePhaseStatus(ROOT, issue, "verification", "running", {
    prNumber: pr.number,
    worktreePath,
    reason: "Running configured verifier.",
  });
  const headSha = (await git(["rev-parse", "HEAD"], worktreePath)).trim();
  const report = await runVerification(config, worktreePath);
  const status = report.ok ? "pass" : "fail";
  const body = verificationReport(report);
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "verification",
    agent: "verifier",
    title: `Verification ${status}`,
    summary: report.ok ? "Verification passed for the current head SHA." : "Verification failed or was refused.",
    body,
    runId,
    status: report.ok ? "complete" : "blocked",
    decision: report.ok ? "proceed" : "block",
    metadata: {
      prNumber: pr.number,
      headSha,
      screenshotsRequired: report.screenshotsRequired,
      files: report.files,
    },
  });
  await commentPR(
    config,
    pr.number,
    verificationComment({ pr: pr.number, issue: issue.number, head: headSha, status, report: body }),
  );
  await setDurablePhaseStatus(ROOT, issue, report.ok ? "finalization" : "verification", report.ok ? "ready" : "blocked", {
    prNumber: pr.number,
    headSha,
    reason: report.ok ? "Verification passed." : "Verification failed or refused.",
  });
  return { ...report, headSha };
}

async function runFinalizationPhase(config, issue, { pr, specDir, runId, verification }) {
  await setDurablePhaseStatus(ROOT, issue, "finalization", "running", {
    prNumber: pr.number,
    reason: "Checking finalization preconditions.",
  });
  if (verification.screenshotsRequired && !(await hasUxScreenshots(specDir))) {
    await setDurablePhaseStatus(ROOT, issue, "finalization", "blocked", {
      prNumber: pr.number,
      reason: "UI changes require screenshots before human PR review.",
    });
    return null;
  }
  const reviewers = [...(config.reviewers ?? []), ...(config.teamReviewers ?? [])];
  if (!reviewers.length) {
    await setDurablePhaseStatus(ROOT, issue, "finalization", "blocked", {
      prNumber: pr.number,
      reason: "No human reviewers are configured.",
    });
    return null;
  }
  await gh(["pr", "ready", String(pr.number), "--repo", config.repository]);
  await gh(["pr", "edit", String(pr.number), "--repo", config.repository, "--add-reviewer", reviewers.join(",")]);
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "finalization",
    agent: "finalizer",
    title: `PR #${pr.number} ready for human review`,
    summary: "Verified draft PR marked ready and reviewers requested.",
    body: `PR #${pr.number} is ready for human review at ${verification.headSha}.`,
    runId,
    status: "complete",
    decision: "proceed",
    metadata: {
      prNumber: pr.number,
      headSha: verification.headSha,
      reviewers,
    },
  });
  await setDurablePhaseStatus(ROOT, issue, "human-pr-review", "ready", {
    prNumber: pr.number,
    headSha: verification.headSha,
    reason: "Automation complete. Waiting for human PR review and merge.",
  });
  return { prNumber: pr.number, headSha: verification.headSha };
}

function parseDecisionLine(text, label, allowed) {
  const re = new RegExp(`^${label}:\\s*(.*?)\\s*$`, "im");
  const decision = String(text ?? "").match(re)?.[1]?.toLowerCase();
  return allowed.includes(decision) ? decision : null;
}

function verificationReport(report) {
  const lines = [];
  for (const result of report.results ?? []) {
    lines.push(`## ${result.command}`);
    lines.push(`Exit code: ${result.code}`);
    if (result.stdout) lines.push("", "stdout:", "```", redactSecrets(result.stdout), "```");
    if (result.stderr) lines.push("", "stderr:", "```", redactSecrets(result.stderr), "```");
  }
  if (report.secretFindings?.length) {
    lines.push("", "## Secret scan findings", ...report.secretFindings.map((finding) => `- ${redactSecrets(finding)}`));
  }
  if (report.screenshotsRequired) {
    lines.push("", "## UX screenshots", "UI files changed; screenshots are required before finalization.");
  }
  return lines.join("\n") || "No verification output.";
}

async function hasUxScreenshots(specDir) {
  const dirs = [path.join(specDir, "screenshots/after"), path.join(specDir, "screenshots")];
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.some((entry) => /\.(png|jpe?g|webp)$/i.test(entry))) return true;
    } catch {
      // directory absent
    }
  }
  return false;
}

function specReviewNeedsHuman(review) {
  return evaluateSpecReview(review).needsHuman;
}

function normalizeAgentMarkdown(text, fallbackTitle) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return `# ${fallbackTitle}\n\nNo content returned.\n`;
  return trimmed.startsWith("#") ? `${trimmed}\n` : `# ${fallbackTitle}\n\n${trimmed}\n`;
}

async function writeIfMissing(file, content) {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, content);
  }
}

function specTemplate(issue) {
  return `# Spec: issue #${issue.number} ${issue.title}\n\n## Problem\n\nTBD by architect.\n\n## Non-goals\n\nTBD.\n\n## Current repo facts\n\nTBD.\n\n## Architecture\n\nTBD.\n\n## Security and privacy\n\nTBD.\n\n## Implementation waves\n\nTBD.\n\n## Acceptance criteria\n\nTBD.\n\n## Verification\n\nTBD.\n\n## UX evidence\n\nTBD.\n`;
}

function firstMeaningfulLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "Agent produced an artifact."
  );
}

function issueRunId(issue) {
  return `issue-${String(issue.number).padStart(4, "0")}-${randomUUID()}`;
}

async function maybeClaim(config, issue, branch) {
  const expires = new Date(Date.now() + config.claimTtlMinutes * 60_000).toISOString();
  const body = `${claimMarker({
    issue: issue.number,
    runId: randomUUID(),
    branch,
    expires,
  })}\n\nAutomation claimed this issue for spec preparation.`;
  await maybeComment(config, issue.number, body);
}

async function maybeCommentRequirements(config, issue, critique, artifactPath = null) {
  const comments = issue.comments ?? (await issueComments(config, issue.number));
  const existing = latestRequirementsMarker(comments);
  let artifactSha = null;
  if (artifactPath && !config.dryRun) {
    artifactSha = await fileSha256(artifactPath);
  }
  if (
    existing?.attrs?.issueInputSha === critique.issueInputSha &&
    existing?.attrs?.status === critique.status &&
    (!artifactSha || existing?.attrs?.artifactSha === artifactSha)
  ) {
    return;
  }
  const marker = requirementsMarker({
    issue: issue.number,
    status: critique.status,
    issueInputSha: critique.issueInputSha,
    artifactSha: config.dryRun ? "dry-run" : artifactSha,
  });
  const body = [
    marker,
    "",
    `Requirements critique: **${critique.status}**`,
    "",
    critique.summary,
    "",
    "Findings:",
    ...(critique.findings.length ? critique.findings.map((item) => `- ${item}`) : ["- None."]),
    "",
    "Questions / blockers:",
    ...(critique.questions.length ? critique.questions.map((item) => `- ${item}`) : ["- None."]),
    "",
    `Next action: ${critique.nextAction}`,
  ].join("\n");
  await maybeComment(config, issue.number, body);
}

async function maybeComment(config, issueNumber, body) {
  if (config.dryRun) {
    console.log(`[dry-run] would comment on issue #${issueNumber}:\n${body}`);
    return;
  }
  await commentIssue(config, issueNumber, body);
}

async function hasTrustedSpecApproval(config, issue, specPath) {
  const labels = issue.labels.map((label) => label.name);
  if (labels.includes(config.automationLabels.specApproved)) {
    console.warn(
      `Ignoring ${config.automationLabels.specApproved} label without a trusted spec-approval marker bound to the current spec hash.`,
    );
  }
  const specRelPath = path.relative(ROOT, specPath);
  let specSha;
  try {
    specSha = await fileSha256(specPath);
  } catch {
    return false;
  }
  const comments = await issueComments(config, issue.number);
  for (const comment of comments) {
    const approvals = parseMarkers(comment.body).filter((marker) => marker.kind === "spec-approval");
    if (approvals.length === 0) continue;
    const login = comment.author?.login;
    if (!login) continue;
    const trusted =
      config.trustedApprovers.includes(login) ||
      hasWritePermission(await collaboratorPermission(config, login));
    if (!trusted) continue;
    if (
      approvals.some(
        (approval) =>
          approval.attrs.issue === String(issue.number) &&
          approval.attrs.path === specRelPath &&
          approval.attrs.sha === specSha,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function fileSha256(file) {
  const buf = await fs.readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

function parseArgs(argv) {
  const args = { once: true, watch: false, dryRun: false, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--watch") args.watch = true;
    else if (arg === "--once") args.once = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--config") args.config = argv[++i];
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
