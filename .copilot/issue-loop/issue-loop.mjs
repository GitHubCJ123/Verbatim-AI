#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
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
  isSecuritySensitiveIssue,
  issueInputSha,
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
import { evaluateEligibility } from "./lib/eligibility.mjs";
import { createBudget, emptyRecoveryState } from "./lib/recovery.mjs";
import {
  completeRecoveryAttempt,
  makeRunModel,
  recoverImplementation,
  recoverRequirements,
  recoverSpecReview,
  recoverVerification,
  recoveryEnabled,
  sharperQuestions,
  summarizeRecovery,
} from "./lib/recovery-driver.mjs";
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

  // Single-active-service guard: refuse to start if another watcher is live, so
  // two schedulers can never process the same issue concurrently (state safety).
  const lock = await acquireServiceLock(ROOT);
  try {
    if (args.watch) {
      while (true) {
        await lock.heartbeat();
        await tick(config, args);
        await sleep(config.pollIntervalSeconds * 1000);
      }
    } else {
      await tick(config, args);
    }
  } finally {
    await lock.release();
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but owned by another user
  }
}

async function acquireServiceLock(root) {
  const lockPath = path.join(root, ".copilot-issue-loop", "service.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const prev = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const fresh = Date.now() - (Number(prev.heartbeat) || 0) < 90_000;
    if (fresh && isProcessAlive(Number(prev.pid))) {
      throw new Error(
        `Another issue-loop service is already running (pid ${prev.pid}, host ${prev.host}). ` +
          `Stop it or remove ${path.relative(root, lockPath)} if it is stale.`,
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (/already running/.test(error.message)) throw error;
      // Corrupt/unreadable lock: treat as stale and overwrite.
    }
  }
  const record = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), heartbeat: Date.now() };
  await fs.writeFile(lockPath, `${JSON.stringify(record)}\n`);
  return {
    async heartbeat() {
      record.heartbeat = Date.now();
      await fs.writeFile(lockPath, `${JSON.stringify(record)}\n`).catch(() => {});
    },
    async release() {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    },
  };
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
      try {
        await processIssue(config, issue, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`processIssue failed for #${issue.number}: ${message}`);
        await setDurablePhaseStatus(ROOT, issue, "implementation", "blocked", {
          reason: `Unhandled error: ${truncateForComment(message, 500)}`,
        }).catch(() => {});
      }
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
  const stopReason = await stopRequested(config, ROOT, labels);
  const openPrs = prs ?? [];
  // Single source of truth for the accept/reject decision (shared with the
  // dashboard) lives in evaluateEligibility. To stay byte-identical to the
  // original driver we preserve its exact short-circuit ORDER and network
  // profile: (1) cheap in-memory gates (stop/labels/linked-PR) first, (2) the
  // network `git ls-remote` branch check only if those pass, (3) active-claim
  // computation (which may fetch comments) last.
  const cheap = evaluateEligibility({
    config,
    issue,
    openPrs,
    stopReason,
    remoteBranchExists: false,
    activeClaims: 0,
  });
  if (!cheap.eligible) return false;
  if (await remoteBranchExists(ROOT, issueBranchName(config, issue))) return false;
  const comments = issue.comments ?? (await issueComments(config, issue.number));
  const activeClaims = activeClaimsFromComments(comments).length;
  return evaluateEligibility({
    config,
    issue,
    openPrs,
    stopReason,
    remoteBranchExists: false,
    activeClaims,
  }).eligible;
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
    const proceed = await maybeRecoverRequirements(config, issue, critique, specDir, runId, args);
    if (!proceed) return;
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
    const proceed = await maybeRecoverSpecReview(config, issue, specPath, review, runId);
    if (!proceed) return;
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

// Requirements gate recovery. Returns true when the issue may proceed to spec
// drafting (recovery downgraded needs-human to clear), false when it must stay
// needs-human. When recovery is disabled or in dry-run, this reproduces the
// EXACT original needs-human behavior (comment + durable status + caller return).
async function maybeRecoverRequirements(config, issue, critique, specDir, runId, args) {
  const dryRun = config.dryRun || args?.dryRun;
  if (!recoveryEnabled(config, "requirements") || dryRun) {
    await maybeCommentRequirements(config, issue, critique);
    await setDurablePhaseStatus(ROOT, issue, "requirements", "needs-human", {
      issueInputSha: critique.issueInputSha,
      reason: critique.summary,
    });
    return false;
  }
  const isSecuritySensitive = isSecuritySensitiveIssue(issue);
  const heuristic = [critique.summary, ...(critique.questions ?? [])].filter(Boolean).join("\n");
  // Honor STOP before spending any recovery model calls: fall back to the exact
  // original needs-human behavior without invoking a model.
  const stop = await stopRequested(config, ROOT, issue.labels.map((label) => label.name));
  if (stop) {
    await maybeCommentRequirements(config, issue, critique);
    await setDurablePhaseStatus(ROOT, issue, "requirements", "needs-human", {
      issueInputSha: critique.issueInputSha,
      reason: critique.summary,
    });
    return false;
  }
  let decision;
  try {
    ({ decision } = await recoverRequirements({
      config,
      issue,
      heuristic,
      isSecuritySensitive,
      budget: createBudget(config.recovery.budgets),
      state: emptyRecoveryState(),
      runModel: makeRunModel(config, ROOT),
    }));
  } catch (err) {
    console.error(`Requirements recovery failed for #${issue.number}: ${err.message}`);
    decision = null;
  }
  if (decision?.proceed) {
    await recordArtifact({
      root: ROOT,
      issue,
      phase: "requirements",
      agent: "recovery-council",
      title: "Requirements recovery cleared for spec drafting",
      summary: decision.reason,
      body: `Requirements recovery (tier: ${decision.tier}) cleared this issue for spec drafting. Spec review and human PR merge gates still apply.`,
      runId,
      status: "complete",
      decision: "recovered",
      metadata: { issueInputSha: critique.issueInputSha, recovery: decision.recovery },
    });
    await setDurablePhaseStatus(ROOT, issue, "requirements", "recovered", {
      issueInputSha: critique.issueInputSha,
      reason: decision.reason,
      recovery: decision.recovery,
    });
    return true;
  }
  const sharper = decision ? sharperQuestions(decision) : [];
  const augmented = sharper.length
    ? { ...critique, questions: [...(critique.questions ?? []), ...sharper] }
    : critique;
  await maybeCommentRequirements(config, issue, augmented);
  await setDurablePhaseStatus(ROOT, issue, "requirements", "needs-human", {
    issueInputSha: critique.issueInputSha,
    reason: decision?.reason ?? critique.summary,
    recovery: decision?.recovery,
  });
  return false;
}

// Spec-review gate recovery. Returns true when the spec may proceed to
// implementation (recovery reached a deterministic proceed with no security
// veto), false when it must stay blocked. When recovery is disabled this
// reproduces the EXACT original block behavior (comment + durable status).
async function consumeHumanContinue(issue, phaseIds) {
  const inputSha = issueInputSha(issue);
  for (const phaseId of phaseIds) {
    const approval = await readDashboardApproval(ROOT, issue, phaseId, { issueInputSha: inputSha });
    if (!approval) continue;
    const summary = await readIssueAutomationSummary(ROOT, issue);
    const details = summary.phaseStatuses?.["spec-review"]?.details ?? {};
    if (details.consumedContinueId === approval.id) continue; // single-use per feedback
    const resumeCount = Number(details.humanResumeCount ?? 0);
    if (resumeCount >= 3) continue; // bounded: stop auto-resuming after 3 human continues
    await setDurablePhaseStatus(ROOT, issue, "spec-review", "approved", {
      consumedContinueId: approval.id,
      humanResumeCount: resumeCount + 1,
      approvalId: approval.id,
      reason: `Human Continue for ${phaseId}: ${truncateForComment(approval.note || "(no note)", 240)}`,
    });
    return { approval, phaseId, note: approval.note ?? "" };
  }
  return null;
}

async function appendHumanGuidance(specPath, note) {
  if (!note || !note.trim()) return;
  const reviewPath = path.join(path.dirname(specPath), "adversarial-review.md");
  const block = `\n\n## Human maintainer guidance (Continue)\n\n${redactSecrets(String(note)).slice(0, 4000)}\n`;
  await fs.appendFile(reviewPath, block).catch(() => {});
}

async function maybeRecoverSpecReview(config, issue, specPath, review, runId) {
  // Human "Continue" from the dashboard overrides the gate: if the maintainer
  // submitted feedback for the blocked spec/review/implementation phase, thread
  // the note to the implementer and proceed to implementation.
  const humanContinue = await consumeHumanContinue(issue, ["adversarial-review", "spec-review", "implementation"]);
  if (humanContinue) {
    await appendHumanGuidance(specPath, humanContinue.note);
    return true;
  }
  const blockAsBefore = async () => {
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
    return false;
  };
  if (!recoveryEnabled(config, "spec-review")) {
    return blockAsBefore();
  }
  // Honor STOP before spending any recovery model calls.
  const stop = await stopRequested(config, ROOT, issue.labels.map((label) => label.name));
  if (stop) {
    return blockAsBefore();
  }
  let decision;
  try {
    const specText = await fs.readFile(specPath, "utf8");
    ({ decision } = await recoverSpecReview({
      config,
      issue,
      specText,
      priorFailure: `Spec review raised open questions requiring human input:\n${review}`,
      budget: createBudget(config.recovery.budgets),
      state: emptyRecoveryState(),
      runModel: makeRunModel(config, ROOT),
    }));
  } catch (err) {
    console.error(`Spec-review recovery failed for #${issue.number}: ${err.message}`);
    decision = null;
  }
  if (!decision?.proceed) {
    if (decision) {
      await setDurablePhaseStatus(ROOT, issue, "spec-review", "needs-human", {
        reason: decision.reason,
        recovery: decision.recovery,
      });
    }
    return blockAsBefore();
  }
  await recordArtifact({
    root: ROOT,
    issue,
    phase: "spec-review",
    agent: "recovery-council",
    title: "Spec review recovery cleared for implementation",
    summary: decision.reason,
    body: `Spec-review recovery (tier: ${decision.tier}) cleared this spec for implementation. Verification and human PR merge gates still apply.`,
    runId,
    status: "complete",
    decision: "recovered",
    metadata: { recovery: decision.recovery },
  });
  await setDurablePhaseStatus(ROOT, issue, "spec-review", "recovered", {
    reason: decision.reason,
    recovery: decision.recovery,
  });
  return true;
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
    specPath,
    branch,
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

  const attemptCtx = { worktree, branch, specPath, specContent, reviewContent, runId };
  let outcome = await attemptImplementation(config, issue, attemptCtx);
  if (outcome.ok) return outcome.value;

  // DEFAULT (recovery disabled): reproduce the original per-failure persistence
  // exactly and give up. Byte-identical to the pre-recovery driver.
  if (!recoveryEnabled(config, "implementation")) {
    await finalizeBlocked(config, issue, outcome.kind, {
      branch,
      worktreePath: worktree.path,
      runId,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      decision: outcome.decision,
      findings: outcome.findings,
    });
    return null;
  }

  // Recovery enabled: rotate roster models on RETRYABLE failures only. Secrets
  // are non-retryable (fail closed). Budget is reserved inside
  // recoverImplementation; the disposable pre-PR worktree is reset between tries.
  const budget = createBudget(config.recovery.budgets);
  let state = emptyRecoveryState();
  const alreadyTried = [config.agents?.implementer?.model].filter(Boolean);

  while (outcome.kind !== "secrets") {
    const rec = recoverImplementation({ config, alreadyTriedModels: alreadyTried, budget, state });
    state = rec.state ?? state;
    if (!rec.nextModel) break;
    const stop = await stopRequested(config, ROOT);
    if (stop) {
      await finalizeBlocked(config, issue, outcome.kind, {
        branch,
        worktreePath: worktree.path,
        runId,
        stderr: outcome.stderr,
        stdout: outcome.stdout,
        decision: outcome.decision,
        findings: outcome.findings,
        recovery: summarizeRecovery(state, {
          outcome: "stopped",
          reason: `Stop requested (${stop}) before recovery re-run.`,
        }),
      });
      return null;
    }
    // branchStrategy "incremental-after-pr": no PR exists yet, so the worktree
    // is disposable and safe to reset clean before the next model runs. We never
    // hard-reset or force-push once a PR or human/non-bot commits exist.
    await git(["reset", "--hard"], worktree.path);
    await git(["clean", "-fd"], worktree.path);
    alreadyTried.push(rec.nextModel);
    await setDurablePhaseStatus(ROOT, issue, "implementation", "running", {
      branch,
      worktreePath: worktree.path,
      reason: `Recovery: re-running implementer with ${rec.nextModel} (attempt ${alreadyTried.length}).`,
    });
    outcome = await attemptImplementation(config, issue, { ...attemptCtx, modelOverride: rec.nextModel });
    state = completeRecoveryAttempt(state, rec.attemptId, {
      proceed: outcome.ok,
      reason: outcome.ok ? "implementer produced changes" : `implementer ${outcome.kind}`,
    });
    if (outcome.ok) {
      await setDurablePhaseStatus(ROOT, issue, "implementation", "complete", {
        prNumber: outcome.value.pr.number,
        headSha: outcome.value.headSha,
        recovery: summarizeRecovery(state, {
          outcome: "proceed",
          proceed: true,
          changed: true,
          tier: "sequentialRetry",
        }),
      });
      return outcome.value;
    }
  }

  await finalizeBlocked(config, issue, outcome.kind, {
    branch,
    worktreePath: worktree.path,
    runId,
    stderr: outcome.stderr,
    stdout: outcome.stdout,
    decision: outcome.decision,
    findings: outcome.findings,
    recovery: summarizeRecovery(state, {
      outcome: outcome.kind === "secrets" ? "veto" : "exhausted",
      reason:
        outcome.kind === "secrets"
          ? "Secret-like text in diff; recovery not permitted."
          : "Implementation recovery exhausted.",
    }),
  });
  return null;
}

// Single implementer attempt. Returns a discriminated result and performs the
// success-path side effects (commit/push/PR/artifact) but NEVER persists a
// terminal "blocked" status — the caller does that via finalizeBlocked so the
// recovery-disabled path stays byte-identical to the original driver.
async function attemptImplementation(
  config,
  issue,
  { worktree, branch, specPath, specContent, reviewContent, runId, modelOverride },
) {
  const runOpts = {
    role: "implementer",
    worktree: worktree.path,
    prompt: implementerPrompt(issue, path.relative(worktree.path, specPath), specContent, reviewContent),
  };
  if (modelOverride) runOpts.modelOverride = modelOverride;
  const result = await runCopilot(config, runOpts);
  if (result.code !== 0) {
    return { ok: false, kind: "error", stderr: result.stderr };
  }

  const decision = parseDecisionLine(result.stdout, "IMPLEMENTATION_DECISION", ["ready", "blocked"]);
  if (decision !== "ready") {
    return { ok: false, kind: "blocked", stdout: result.stdout, decision };
  }

  await git(["add", "-A"], worktree.path);
  const stagedFiles = await git(["diff", "--cached", "--name-only"], worktree.path);
  if (!stagedFiles.trim()) {
    return { ok: false, kind: "no-changes" };
  }

  const diff = await git(["diff", "--cached"], worktree.path);
  const secretFindings = findSecretLikeText(diff);
  if (secretFindings.length) {
    return { ok: false, kind: "secrets", findings: secretFindings };
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
  return { ok: true, value: { pr, worktreePath: worktree.path, headSha } };
}

// Persist a terminal "implementation blocked" outcome, replicating the exact
// per-failure-kind side effects of the original driver. A redacted `recovery`
// summary is attached ONLY when recovery ran (undefined on the default path).
async function finalizeBlocked(config, issue, kind, ctx) {
  const { branch, worktreePath, runId, stderr, stdout, decision, findings, recovery } = ctx;
  const withRecovery = (details) => (recovery ? { ...details, recovery } : details);
  if (kind === "error") {
    await setDurablePhaseStatus(
      ROOT,
      issue,
      "implementation",
      "blocked",
      withRecovery({
        reason: truncateForComment(stderr, 1000),
        branch,
        worktreePath,
      }),
    );
    return;
  }
  if (kind === "blocked") {
    await recordArtifact({
      root: ROOT,
      issue,
      phase: "implementation",
      agent: "implementer",
      title: "Implementation blocked",
      summary: "Implementer reported that the spec could not be implemented safely.",
      body: stdout,
      runId,
      status: "blocked",
      decision: decision ?? "blocked",
      metadata: withRecovery({ branch, worktreePath }),
    });
    return;
  }
  if (kind === "no-changes") {
    await setDurablePhaseStatus(
      ROOT,
      issue,
      "implementation",
      "blocked",
      withRecovery({
        reason: "Implementer completed without file changes.",
        branch,
        worktreePath,
      }),
    );
    return;
  }
  if (kind === "secrets") {
    await setDurablePhaseStatus(
      ROOT,
      issue,
      "implementation",
      "blocked",
      withRecovery({
        reason: "Secret-like text found in implementation diff.",
        branch,
        worktreePath,
        findings,
      }),
    );
  }
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

async function runVerificationPhase(config, issue, { pr, worktreePath, specPath, branch, runId }) {
  let result = await verifyOnce(config, issue, { pr, worktreePath, runId });
  if (result.ok) return result;

  // DEFAULT (recovery disabled): identical to the original single-pass verifier.
  if (!recoveryEnabled(config, "verification") || config.dryRun) return result;
  // The implementer can never fix a host sandbox refusal — don't waste repairs.
  if (isSandboxRefusal(result)) return result;

  const budget = createBudget(config.recovery.budgets);
  let state = emptyRecoveryState();
  let attemptsSoFar = 0;

  for (;;) {
    const stop = await stopRequested(config, ROOT);
    if (stop) {
      await setDurablePhaseStatus(ROOT, issue, "verification", "blocked", {
        prNumber: pr.number,
        headSha: result.headSha,
        reason: `Stop requested (${stop}) before verifier repair.`,
        recovery: summarizeRecovery(state, { outcome: "stopped", reason: `Stop requested (${stop}).` }),
      });
      return result;
    }
    const rec = recoverVerification({ config, budget, attemptsSoFar, state });
    state = rec.state ?? state;
    if (!rec.shouldRepair || !rec.model) break;
    attemptsSoFar += 1;

    const repaired = await repairForVerification(config, issue, {
      worktreePath,
      specPath,
      branch,
      model: rec.model,
      failureText: verificationReport(result),
    });
    // The verifier stays authoritative: a repair is NEVER treated as "proceed".
    state = completeRecoveryAttempt(state, rec.attemptId, {
      proceed: false,
      reason: repaired.committed ? "repair committed" : `repair no-op (${repaired.reason})`,
    });
    if (repaired.blockedBySecret) {
      await setDurablePhaseStatus(ROOT, issue, "verification", "blocked", {
        prNumber: pr.number,
        headSha: result.headSha,
        reason: "Secret-like text found in verifier repair diff; repair rejected.",
        recovery: summarizeRecovery(state, { outcome: "veto", reason: "Secret-like text in repair diff." }),
      });
      return result;
    }
    if (!repaired.committed) break;

    // Re-run the REAL verifier (authoritative) on the repaired head.
    result = await verifyOnce(config, issue, { pr, worktreePath, runId });
    if (result.ok) {
      await setDurablePhaseStatus(ROOT, issue, "verification", "pass", {
        prNumber: pr.number,
        headSha: result.headSha,
        recovery: summarizeRecovery(state, {
          outcome: "proceed",
          proceed: true,
          changed: true,
          tier: "repairOnly",
        }),
      });
      return result;
    }
  }

  // Exhausted. The last verifyOnce already persisted the failing state; attach a
  // redacted recovery summary. Never mark a failing verification as passing.
  await setDurablePhaseStatus(ROOT, issue, "verification", "blocked", {
    prNumber: pr.number,
    headSha: result.headSha,
    reason: "Verifier repair loop exhausted; verification still failing.",
    recovery: summarizeRecovery(state, { outcome: "exhausted", reason: "Verifier repair exhausted." }),
  });
  return result;
}

// True when a verification report is a host-sandbox refusal (fail-closed
// preflight), which reflects host configuration, not fixable spec/code failures.
function isSandboxRefusal(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  return results.length === 1 && results[0]?.command === "sandbox preflight";
}

// Re-run the implementer to FIX verification failures, then commit + push
// incrementally (never force-push). Rejects and unstages any secret-like diff.
async function repairForVerification(config, issue, { worktreePath, specPath, branch, model, failureText }) {
  const specContent = await fs.readFile(specPath, "utf8").catch(() => "");
  const prompt = implementerPrompt(
    issue,
    path.relative(worktreePath, specPath),
    specContent,
    [
      "The automated verifier FAILED. Fix the failing lint/tests/build below WITHOUT weakening,",
      "skipping, or disabling any check, and WITHOUT introducing secrets. Make the smallest change",
      "that makes verification pass.",
      "",
      "Verifier output:",
      redactSecrets(truncateForComment(failureText, 4000)),
    ].join("\n"),
  );
  const result = await runCopilot(config, {
    role: "implementer",
    worktree: worktreePath,
    prompt,
    modelOverride: model,
  });
  if (result.code !== 0) {
    return { committed: false, reason: "implementer error", blockedBySecret: false };
  }
  await git(["add", "-A"], worktreePath);
  const staged = await git(["diff", "--cached", "--name-only"], worktreePath);
  if (!staged.trim()) {
    return { committed: false, reason: "no changes", blockedBySecret: false };
  }
  const diff = await git(["diff", "--cached"], worktreePath);
  if (findSecretLikeText(diff).length) {
    await git(["reset"], worktreePath);
    return { committed: false, reason: "secret findings", blockedBySecret: true };
  }
  await git(["diff", "--cached", "--check"], worktreePath);
  await git(
    [
      "commit",
      "-m",
      `Repair verification for issue #${issue.number}`,
      "-m",
      "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    ],
    worktreePath,
  );
  await git(["push", "origin", branch], worktreePath);
  return { committed: true, reason: "committed", blockedBySecret: false };
}

async function verifyOnce(config, issue, { pr, worktreePath, runId }) {
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
