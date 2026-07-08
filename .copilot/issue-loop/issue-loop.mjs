#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
  gh,
  hasWritePermission,
  issueComments,
  listOpenIssues,
  listOpenPRs,
} from "./lib/github.mjs";
import { ensureRuntimeDir, remoteBranchExists } from "./lib/git.mjs";
import {
  adversarialPrompt,
  assertArchitectReviewerDiversity,
  architectPrompt,
  runCopilot,
} from "./lib/copilot.mjs";
import {
  critiqueRequirements,
  latestRequirementsMarker,
  requirementsMarker,
  requirementsReview,
} from "./lib/requirements.mjs";

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
    return;
  }

  for (const issue of selected) {
    await processIssue(config, issue, args);
  }
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
  const specDir = path.join(ROOT, "docs/automation/specs", issueFolderName(issue));
  const specPath = path.join(specDir, "spec.md");
  console.log(`Selected issue #${issue.number}: ${issue.title}`);
  console.log(`Spec path: ${path.relative(ROOT, specPath)}`);

  const critique = critiqueRequirements(issue);
  if (critique.status === "needs-human") {
    await maybeCommentRequirements(config, issue, critique);
    return;
  }

  const review = await writeSpecAndReview(config, issue, specDir, specPath, critique, args);
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
      return;
  }

  console.log("Requirements/spec review gates passed. Implementation phase is intentionally delegated to issue-implementer.");
}

async function maybeProcessRequirementsOnly(config, issue) {
  const critique = critiqueRequirements(issue);
  if (critique.status === "clear") {
    const specDir = path.join(ROOT, "docs/automation/specs", issueFolderName(issue));
    const specPath = path.join(specDir, "spec.md");
    await writeSpecAndReview(config, issue, specDir, specPath, critique, { dryRun: config.dryRun });
    await maybeCommentRequirements(config, issue, critique, path.join(specDir, "requirements-review.md"));
  } else {
    await maybeCommentRequirements(config, issue, critique);
  }
}

async function writeSpecAndReview(config, issue, specDir, specPath, critique, args) {
  await writeSpecScaffold(config, issue, specDir, critique);
  if (config.dryRun || args.dryRun) {
    console.log(`[dry-run] would run architect and adversarial reviewer for issue #${issue.number}`);
    return "";
  }
  await writeArchitectSpec(config, issue, specPath);
  const reviewPath = path.join(specDir, "adversarial-review.md");
  return writeAdversarialReview(config, issue, specPath, reviewPath);
}

async function writeSpecScaffold(config, issue, specDir, critique) {
  if (config.dryRun) {
    console.log(`[dry-run] would write spec scaffold in ${path.relative(ROOT, specDir)}`);
    return;
  }
  await fs.mkdir(path.join(specDir, "screenshots/before"), { recursive: true });
  await fs.mkdir(path.join(specDir, "screenshots/after"), { recursive: true });
  const reviewPath = path.join(specDir, "requirements-review.md");
  await fs.writeFile(reviewPath, requirementsReview(issue, critique));
  await writeIfMissing(path.join(specDir, "spec.md"), specTemplate(issue));
  await writeIfMissing(path.join(specDir, "adversarial-review.md"), "# Adversarial review\n\nPending.\n");
  await writeIfMissing(path.join(specDir, "test-plan.md"), "# Test plan\n\nPending.\n");
  await writeIfMissing(path.join(specDir, "security-notes.md"), "# Security notes\n\nPending.\n");
  await writeIfMissing(path.join(specDir, "ux-evidence.md"), "# UX evidence\n\nPending.\n");
}

async function writeArchitectSpec(config, issue, specPath) {
  const result = await runCopilot(config, {
    role: "architect",
    worktree: ROOT,
    prompt: architectPrompt(issue, path.relative(ROOT, specPath)),
  });
  if (result.code !== 0) throw new Error(result.stderr);
  await fs.writeFile(specPath, normalizeAgentMarkdown(result.stdout, "Spec"));
}

async function writeAdversarialReview(config, issue, specPath, reviewPath) {
  const specContent = await fs.readFile(specPath, "utf8");
  const result = await runCopilot(config, {
    role: "adversarialReviewer",
    worktree: ROOT,
    prompt: adversarialPrompt(issue, path.relative(ROOT, specPath), specContent),
  });
  if (result.code !== 0) throw new Error(result.stderr);
  const review = normalizeAgentMarkdown(result.stdout, "Adversarial review");
  await fs.writeFile(reviewPath, review);
  return review;
}

function specReviewNeedsHuman(review) {
  const decision = String(review).match(/^SPEC_REVIEW_DECISION:\s*(proceed|needs-human)\s*$/im)?.[1];
  if (!decision) return true;
  if (decision === "needs-human") return true;
  return /\b(needs[-\s]?human|requires human|open question|cannot proceed|blocked)\b/i.test(
    review,
  );
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

async function maybeClaim(config, issue, branch) {
  const expires = new Date(Date.now() + config.claimTtlMinutes * 60_000).toISOString();
  const body = `${claimMarker({
    issue: issue.number,
    runId: crypto.randomUUID(),
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
