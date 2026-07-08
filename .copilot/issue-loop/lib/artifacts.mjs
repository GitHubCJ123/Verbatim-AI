import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildMarker, issueFolderName } from "./markers.mjs";
import { redactSecrets } from "./redaction.mjs";

export const ARTIFACT_PHASE_PREFIXES = Object.freeze({
  requirements: "PRD",
  spec: "SPEC",
  "adversarial-review": "ADV",
  implementation: "IMPL",
  "agent-pr-review": "REVIEW",
  verification: "VER",
  finalization: "FINAL",
  "human-pr-review": "HUMAN",
  "self-reflection": "REFLECT",
  cleanup: "CLEAN",
});

const SUMMARY_VERSION = 1;
const SENSITIVE_METADATA_KEY_TOKENS = new Set([
  "arg",
  "args",
  "authorization",
  "command",
  "env",
  "environment",
  "header",
  "headers",
  "key",
  "log",
  "logs",
  "message",
  "messages",
  "output",
  "password",
  "prompt",
  "raw",
  "result",
  "results",
  "secret",
  "stderr",
  "stdout",
  "token",
]);

export function artifactDirectory(root, issue) {
  return path.join(root, "docs/automation/specs", issueFolderName(issue), "artifacts");
}

export function summaryPath(root, issue) {
  return path.join(artifactDirectory(root, issue), "summary.json");
}

export function runlogPath(root, issue) {
  return path.join(artifactDirectory(root, issue), "runlog.jsonl");
}

export function nextArtifactId(summary, typeOrPhase) {
  const prefix = artifactPrefix(typeOrPhase);
  const artifacts = Array.isArray(summary?.artifacts) ? summary.artifacts : [];
  const max = artifacts.reduce((highest, artifact) => {
    const displayId = String(artifact?.displayId ?? "");
    const match = displayId.match(new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`, "i"));
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

export function canonicalArtifactId(issue, runId, displayId) {
  const number = Number(issue?.number);
  const issueSegment = Number.isFinite(number)
    ? `issue-${String(number).padStart(4, "0")}`
    : safeIdSegment(issueFolderName(issue));
  return [issueSegment, safeIdSegment(runId || "run"), safeIdSegment(displayId)]
    .filter(Boolean)
    .join("-");
}

export async function readIssueAutomationSummary(root, issue) {
  try {
    const raw = await fs.readFile(summaryPath(root, issue), "utf8");
    return normalizeSummary(JSON.parse(raw));
  } catch {
    return emptySummary();
  }
}

export async function appendRunlog(root, issue, event) {
  const file = runlogPath(root, issue);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const safeEvent = sanitizeJsonValue(event);
  const entry = sanitizeJsonValue({
    at: new Date().toISOString(),
    ...(safeEvent && typeof safeEvent === "object" && !Array.isArray(safeEvent)
      ? safeEvent
      : { event: safeEvent }),
  });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function setDurablePhaseStatus(root, issue, phase, status, details = {}) {
  const existingSummary = await readIssueAutomationSummary(root, issue);
  const updatedAt = new Date().toISOString();
  const safeDetails = sanitizeJsonValue(details ?? {});
  const current = existingSummary.phaseStatuses?.[phase] ?? {};
  const nextSummary = normalizeSummary({
    ...existingSummary,
    issue: existingSummary.issue ?? {
      number: issue?.number ?? null,
      title: redactText(issue?.title ?? ""),
      folder: issueFolderName(issue),
    },
    updatedAt,
    phaseStatuses: {
      ...existingSummary.phaseStatuses,
      [phase]: {
        ...current,
        status,
        updatedAt,
        details: safeDetails,
      },
    },
  });
  await fs.mkdir(path.dirname(summaryPath(root, issue)), { recursive: true });
  await fs.writeFile(summaryPath(root, issue), `${JSON.stringify(nextSummary, null, 2)}\n`, "utf8");
  await appendRunlog(root, issue, {
    type: "phase.status",
    phase,
    status,
    details: safeDetails,
  });
  return nextSummary;
}

export async function recordArtifact({
  root,
  issue,
  phase,
  agent,
  title,
  summary,
  body,
  runId,
  status = "complete",
  decision = null,
  metadata,
}) {
  const prefix = artifactPrefix(phase);
  const existingSummary = await readIssueAutomationSummary(root, issue);
  const displayId = nextArtifactId(existingSummary, phase);
  const canonicalId = canonicalArtifactId(issue, runId, displayId);
  const createdAt = new Date().toISOString();
  const dir = artifactDirectory(root, issue);
  const file = path.join(dir, `${displayId}.md`);

  const safeTitle = redactText(title || `${phase} artifact`);
  const safeSummary = redactText(summary || "");
  const safeBody = redactText(body || "");
  const safeAgent = redactText(agent || "automation").slice(0, 160);
  const safeRunId = redactText(runId || "run").slice(0, 160);
  const safeMetadata = sanitizeJsonValue(metadata ?? {});

  const marker = buildMarker("artifact", {
    issue: issue?.number,
    phase,
    id: canonicalId,
    display: displayId,
    run: safeRunId,
  });
  const markdown = `${marker}
# ${displayId}: ${safeTitle}

- Issue: #${issue?.number ?? "unknown"}
- Phase: ${phase}
- Prefix: ${prefix}
- Artifact ID: ${canonicalId}
- Agent: ${safeAgent}
- Run: ${safeRunId}
- Created: ${createdAt}

## Summary

${safeSummary || "No summary provided."}

## Body

${safeBody || "No body provided."}
`;
  const sha256 = crypto.createHash("sha256").update(markdown).digest("hex");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, markdown, "utf8");

  const artifact = {
    id: canonicalId,
    displayId,
    phase,
    prefix,
    title: safeTitle,
    summary: safeSummary,
    agent: safeAgent,
    runId: safeRunId,
    status: redactText(status || "complete"),
    decision: decision ? redactText(decision) : null,
    path: toPosixPath(path.relative(root, file)),
    sha256,
    createdAt,
    metadata: safeMetadata,
  };

  const updatedSummary = updateSummary(existingSummary, issue, artifact);
  await appendRunlog(root, issue, {
    type: "artifact.recorded",
    artifact: {
      id: artifact.id,
      displayId: artifact.displayId,
      phase: artifact.phase,
      path: artifact.path,
      sha256: artifact.sha256,
    },
  });
  await fs.writeFile(summaryPath(root, issue), `${JSON.stringify(updatedSummary, null, 2)}\n`, "utf8");

  return { artifact, path: file, sha256, summary: updatedSummary };
}

function updateSummary(summary, issue, artifact) {
  const normalized = normalizeSummary(summary);
  const artifacts = [...normalized.artifacts, artifact];
  const latestArtifacts = {
    ...normalized.latestArtifacts,
    [artifact.phase]: artifact,
  };
  const phaseCount = artifacts.filter((item) => item.phase === artifact.phase).length;
  const phaseStatuses = {
    ...normalized.phaseStatuses,
    [artifact.phase]: {
      status: artifact.status,
      decision: artifact.decision,
      latestArtifactId: artifact.id,
      latestDisplayId: artifact.displayId,
      count: phaseCount,
      updatedAt: artifact.createdAt,
    },
  };

  return {
    version: SUMMARY_VERSION,
    issue: {
      number: issue?.number ?? null,
      title: redactText(issue?.title ?? ""),
      folder: issueFolderName(issue),
    },
    updatedAt: artifact.createdAt,
    artifacts,
    latestArtifacts,
    phaseStatuses,
  };
}

function normalizeSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return emptySummary();
  return {
    version: SUMMARY_VERSION,
    issue: summary.issue && typeof summary.issue === "object" ? sanitizeJsonValue(summary.issue) : null,
    updatedAt: typeof summary.updatedAt === "string" ? redactText(summary.updatedAt) : null,
    artifacts: Array.isArray(summary.artifacts)
      ? summary.artifacts.filter((artifact) => artifact && typeof artifact === "object").map(sanitizeJsonValue)
      : [],
    latestArtifacts:
      summary.latestArtifacts && typeof summary.latestArtifacts === "object" && !Array.isArray(summary.latestArtifacts)
        ? sanitizeJsonValue(summary.latestArtifacts)
        : {},
    phaseStatuses:
      summary.phaseStatuses && typeof summary.phaseStatuses === "object" && !Array.isArray(summary.phaseStatuses)
        ? sanitizeJsonValue(summary.phaseStatuses)
        : {},
  };
}

function emptySummary() {
  return {
    version: SUMMARY_VERSION,
    issue: null,
    updatedAt: null,
    artifacts: [],
    latestArtifacts: {},
    phaseStatuses: {},
  };
}

function artifactPrefix(typeOrPhase) {
  const prefix = ARTIFACT_PHASE_PREFIXES[typeOrPhase] ?? String(typeOrPhase ?? "").toUpperCase();
  if (!/^[A-Z][A-Z0-9-]*$/.test(prefix)) {
    throw new Error(`Unknown artifact phase/type: ${typeOrPhase}`);
  }
  return prefix;
}

function sanitizeJsonValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSensitiveMetadataKey(key))
        .map(([key, nestedValue]) => [redactText(key), sanitizeJsonValue(nestedValue)]),
    );
  }
  return redactText(String(value));
}

function redactText(value) {
  return redactSecrets(String(value ?? ""));
}

function safeIdSegment(value) {
  return redactText(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isSensitiveMetadataKey(key) {
  return keyTokens(key).some((token) => SENSITIVE_METADATA_KEY_TOKENS.has(token));
}

function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
