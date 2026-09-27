#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ghJson } from "./lib/github.mjs";
import {
  applyApproval,
  applyRerun,
  buildPhaseView,
  canRecoverPhase,
  computeRecoveryPlan,
  deriveIssueState,
  ensureDashboardState,
  feedbackPrompt,
  PHASES,
  recordFeedback,
  recordReflection,
  reflectionPrompt,
  RERUN_ELIGIBLE_PHASES,
  runTextAgent,
  runtimeDirFor,
  saveDashboardState,
  statePathFor,
  startAction,
  finishAction,
  setPhaseStatus,
  issueState,
} from "./lib/dashboard.mjs";
import { appendRunlog, resolveArtifactFilePath } from "./lib/artifacts.mjs";
import { redactSecrets } from "./lib/redaction.mjs";
import { DEFAULT_CONFIG, loadConfig } from "./lib/config.mjs";
import { acquireLock, releaseLock } from "./lib/recovery.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UI_DIR = path.join(ROOT, ".copilot/issue-loop/ui");

// Merged config, memoized. Prefer config.local.json (what the service runs),
// then the committed config.example.json, then the in-code DEFAULT_CONFIG. This
// keeps the dashboard pointed at the operator's real repository/settings and
// makes the loop portable to any project.
let cachedConfig = null;
async function getConfig() {
  if (cachedConfig) return cachedConfig;
  const candidates = [
    path.join(ROOT, ".copilot/issue-loop/config.local.json"),
    path.join(ROOT, ".copilot/issue-loop/config.example.json"),
  ];
  for (const candidate of candidates) {
    try {
      cachedConfig = await loadConfig(candidate);
      return cachedConfig;
    } catch {
      // Missing or invalid; fall through to the next candidate.
    }
  }
  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = args.host ?? "127.0.0.1";
  const port = Number(args.port ?? 8787);
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Dashboard only binds to localhost addresses.");
  }
  const token = randomBytes(24).toString("hex");
  const statePath = statePathFor(ROOT);
  const runtimeDir = runtimeDirFor(ROOT);
  let state = await ensureDashboardState(runtimeDir);
  const rateLimits = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, { args, token, port, host, statePath, rateLimits, get state() { return state; }, setState: (next) => { state = next; } });
    } catch (error) {
      sendJson(res, error?.statusCode ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, host, () => {
    console.log(`Automation dashboard running at http://${host}:${port}/`);
    console.log(`Demo issue is enabled. API token is session-only.`);
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  setSecurityHeaders(res);

  if (url.pathname === "/") {
    const html = await fs.readFile(path.join(UI_DIR, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html.replace("__DASHBOARD_TOKEN__", ctx.token));
    return;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }

  if (url.pathname.startsWith("/ui/")) {
    await serveStatic(req, res, url.pathname.slice(4));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    requireApiRequest(req, ctx.token);
    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, await buildState(ctx));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      sendJson(res, 200, await buildHistory());
      return;
    }
    const artifactMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/artifacts\/([^/]+)$/);
    if (req.method === "GET" && artifactMatch) {
      await handleArtifactContent(res, ctx, decodeURIComponent(artifactMatch[1]), decodeURIComponent(artifactMatch[2]));
      return;
    }
    if (req.method === "POST") {
      await handlePost(req, res, url, ctx);
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  res.writeHead(404).end("Not found");
}

async function handlePost(req, res, url, ctx) {
  requireMutation(req);
  const recover = url.pathname.match(/^\/api\/issues\/([^/]+)\/phases\/([^/]+)\/recover$/);
  if (recover) {
    const [, issueId, phaseId] = recover;
    return handleRecover(req, res, ctx, issueId, phaseId);
  }

  const continuePhase = url.pathname.match(/^\/api\/issues\/([^/]+)\/phases\/([^/]+)\/continue$/);
  if (continuePhase) {
    const [, issueId, phaseId] = continuePhase;
    return handleContinue(req, res, ctx, issueId, phaseId);
  }

  const body = await readJson(req).catch(() => {
    throw httpError(400, "Invalid JSON");
  });
  const approve = url.pathname.match(/^\/api\/issues\/([^/]+)\/phases\/([^/]+)\/approve$/);
  if (approve) {
    const [, issueId, phaseId] = approve;
    const stateIssue = applyApproval(ctx.state, issueId, phaseId, body);
    rotateNonce(ctx.state);
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 200, { ok: true, issue: stateIssue, state: await buildState(ctx) });
    return;
  }

  const rerun = url.pathname.match(/^\/api\/issues\/([^/]+)\/phases\/([^/]+)\/rerun$/);
  if (rerun) {
    const [, issueId, phaseId] = rerun;
    if (!RERUN_ELIGIBLE_PHASES.has(phaseId)) {
      return sendJson(res, 409, { error: "This phase cannot be re-run from the dashboard" });
    }
    const stateIssue = applyRerun(ctx.state, issueId, phaseId, {
      note: body.note ?? body.feedback ?? "",
      issueInputSha: body.issueInputSha,
    });
    await appendRunlog(ROOT, { number: Number(String(issueId).replace(/^gh-/, "")) || 0 }, {
      type: "dashboard.rerun",
      phaseId,
      at: new Date().toISOString(),
    });
    rotateNonce(ctx.state);
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 202, { ok: true, issue: stateIssue, state: await buildState(ctx) });
    return;
  }

  const feedback = url.pathname.match(/^\/api\/issues\/([^/]+)\/phases\/([^/]+)\/feedback$/);
  if (feedback) {
    const [, issueId, phaseId] = feedback;
    const dashboard = await buildState(ctx);
    const issue = dashboard.issues.find((item) => item.id === issueId);
    if (!issue) return sendJson(res, 404, { error: "Issue not found" });
    const phase = issue.phases.find((item) => item.id === phaseId);
    const action = startAction(ctx.state, issueId, phaseId, "feedback-agent", "Processing human feedback");
    rotateNonce(ctx.state);
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 202, { ok: true, action, state: await buildState(ctx) });
    void runFeedbackJob(ctx, {
      issue,
      issueId,
      phaseId,
      phase,
      actionId: action.id,
      feedback: body.feedback ?? "",
      runAgent: Boolean(body.runAgent),
    });
    return;
  }

  const reflect = url.pathname.match(/^\/api\/issues\/([^/]+)\/reflect$/);
  if (reflect) {
    const [, issueId] = reflect;
    const dashboard = await buildState(ctx);
    const issue = dashboard.issues.find((item) => item.id === issueId);
    if (!issue) return sendJson(res, 404, { error: "Issue not found" });
    const action = startAction(ctx.state, issueId, "self-reflection", "Running loop self-reflection");
    rotateNonce(ctx.state);
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 202, { ok: true, action, state: await buildState(ctx) });
    void runReflectionJob(ctx, { issue, issueId, actionId: action.id, runAgent: Boolean(body.runAgent) });
    return;
  }

  sendJson(res, 404, { error: "Unknown endpoint" });
}

async function handleContinue(req, res, ctx, issueId, phaseId) {
  if (req.headers["x-dashboard-nonce"] !== currentNonce(ctx.state)) {
    return sendJson(res, 403, { error: "Bad dashboard nonce" });
  }
  const rateKey = `${issueId}:${phaseId}`;
  if (shouldRateLimit(ctx.rateLimits ?? new Map(), rateKey, Date.now())) {
    return sendJson(res, 429, { error: "Continue is rate limited for this phase" });
  }

  const dashboard = await buildState(ctx);
  const issue = dashboard.issues.find((item) => item.id === issueId);
  if (!issue) return sendJson(res, 404, { error: "Issue not found" });
  const phase = issue.phases.find((item) => item.id === phaseId);
  if (!phase) return sendJson(res, 404, { error: "Phase not found" });
  if (!canRecoverPhase(phase.status) && phase.status !== "needs-human" && phase.status !== "blocked") {
    return sendJson(res, 409, { error: "Phase is not waiting on human feedback" });
  }

  const body = await readJson(req).catch(() => {
    throw httpError(400, "Invalid JSON");
  });
  const feedback = String(body.feedback ?? "").slice(0, 6000);
  if (!feedback.trim()) return sendJson(res, 400, { error: "Feedback is required" });

  applyApproval(ctx.state, issueId, phaseId, {
    approver: "local-maintainer",
    note: feedback,
    issueInputSha: body.issueInputSha,
    spec: issue.spec,
  });
  await appendRunlog(ROOT, { number: issue.number }, {
    type: "dashboard.continue",
    phaseId,
    at: new Date().toISOString(),
  });
  rotateNonce(ctx.state);
  await saveDashboardState(ctx.statePath, ctx.state);
  return sendJson(res, 202, { ok: true, state: await buildState(ctx) });
}

async function handleRecover(req, res, ctx, issueId, phaseId) {
  if (req.headers["x-dashboard-nonce"] !== currentNonce(ctx.state)) {
    return sendJson(res, 403, { error: "Bad dashboard nonce" });
  }
  const rateKey = `${issueId}:${phaseId}`;
  if (shouldRateLimit(ctx.rateLimits ?? new Map(), rateKey, Date.now())) {
    return sendJson(res, 429, { error: "Recover is rate limited for this phase" });
  }
  await readJson(req).catch(() => {
    throw httpError(400, "Invalid JSON");
  });

  const dashboard = await buildState(ctx);
  const issue = dashboard.issues.find((item) => item.id === issueId);
  if (!issue) return sendJson(res, 404, { error: "Issue not found" });
  const phase = issue.phases.find((item) => item.id === phaseId);
  if (!phase) return sendJson(res, 404, { error: "Phase not found" });
  if (!canRecoverPhase(phase.status)) {
    return sendJson(res, 409, { error: "Phase is not recoverable" });
  }
  const blockingEligibility = blockingEligibilityReasonsForRecovery(issue);
  if (blockingEligibility.length) {
    return sendJson(res, 409, {
      error: blockingEligibility[0].message ?? "Issue is not eligible for recovery",
      reasons: blockingEligibility,
    });
  }

  const stateIssue = issueState(ctx.state, issueId);
  const recoveryConfig = await getConfig();
  const lockResult = acquireLock(stateIssue.recoveryLock, {
    ttlMinutes: recoveryConfig.recovery.locking.ttlMinutes,
    operation: `dashboard-recover:${phaseId}`,
  });
  if (!lockResult.ok) {
    return sendJson(res, 423, { error: "Recovery is already locked for this issue" });
  }
  stateIssue.recoveryLock = lockResult.lock;

  let action;
  try {
    await appendRunlog(ROOT, { number: issue.number }, {
      type: "dashboard.recover",
      phaseId,
      at: new Date().toISOString(),
    });
    action = startAction(ctx.state, issueId, phaseId, "recover-plan", "Planning recovery");
    const plan = computeRecoveryPlan({ config: recoveryConfig, phaseId });
    stateIssue.recoveryPlans ??= {};
    stateIssue.recoveryPlans[phaseId] = {
      plan,
      createdAt: new Date().toISOString(),
      planningOnly: true,
    };
    stateIssue.events ??= [];
    stateIssue.events.push({
      id: randomBytes(16).toString("hex"),
      type: "recovery-plan",
      phaseId,
      message: "Planning-only recovery plan recorded; CLI driver must execute recovery.",
      plan,
      createdAt: new Date().toISOString(),
    });
    setPhaseStatus(stateIssue, phaseId, phase.status, {
      from: phase.status,
      source: "dashboard-recover",
      message: "Recovery plan recorded; waiting for CLI driver execution.",
    });
    finishAction(ctx.state, issueId, action.id, "complete", "Recovery plan recorded");
    stateIssue.recoveryLock = releaseLock();
    rotateNonce(ctx.state);
    await saveDashboardState(ctx.statePath, ctx.state);
    return sendJson(res, 202, { ok: true, plan, action, state: await buildState(ctx) });
  } catch (error) {
    if (action) finishAction(ctx.state, issueId, action.id, "failed", error instanceof Error ? error.message : String(error));
    stateIssue.recoveryLock = releaseLock();
    await saveDashboardState(ctx.statePath, ctx.state);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function runFeedbackJob(ctx, { issue, issueId, phaseId, phase, actionId, feedback, runAgent }) {
  try {
    const prompt = feedbackPrompt(issue, phaseId, feedback, phase?.output ?? "", (await getConfig()).projectName);
    const agentResult = await runTextAgent({
      prompt,
      allowAgentRuns: Boolean(ctx.args.allowAgentRuns && runAgent),
      agentCommand: ctx.args.agentCommand,
    });
    recordFeedback(ctx.state, issueId, phaseId, feedback, agentResult);
    if (actionId) finishAction(ctx.state, issueId, actionId, "complete", "Feedback processed");
  } catch (error) {
    if (actionId) {
      finishAction(
        ctx.state,
        issueId,
        actionId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    await saveDashboardState(ctx.statePath, ctx.state);
  }
}

async function runReflectionJob(ctx, { issue, issueId, actionId, runAgent }) {
  try {
    const prompt = reflectionPrompt(issue, issue.phases, issue.local.feedback ?? []);
    const result = await runTextAgent({
      prompt,
      allowAgentRuns: Boolean(ctx.args.allowAgentRuns && runAgent),
      agentCommand: ctx.args.agentCommand,
    });
    recordReflection(ctx.state, issueId, result);
    if (actionId) finishAction(ctx.state, issueId, actionId, "complete", "Self-reflection complete");
  } catch (error) {
    if (actionId) {
      finishAction(
        ctx.state,
        issueId,
        actionId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    await saveDashboardState(ctx.statePath, ctx.state);
  }
}

// Resolve an artifact's on-disk path defensively (see resolveArtifactFilePath).
function resolveArtifactPath(issue, relPath) {
  return resolveArtifactFilePath(ROOT, issue, relPath);
}

async function handleArtifactContent(res, ctx, issueId, artifactId) {
  const dashboard = await buildState(ctx);
  const issue = dashboard.issues.find((item) => item.id === issueId);
  if (!issue) return sendJson(res, 404, { error: "Issue not found" });
  const artifacts = issue.automationSummary?.artifacts ?? [];
  const artifact = artifacts.find((item) => item.displayId === artifactId || item.id === artifactId);
  if (!artifact || !artifact.path) return sendJson(res, 404, { error: "Artifact not found" });

  const resolved = resolveArtifactPath(issue, artifact.path);
  if (!resolved) return sendJson(res, 403, { error: "Artifact path is outside the allowed directory" });

  let content;
  try {
    content = await fs.readFile(resolved, "utf8");
  } catch {
    return sendJson(res, 404, { error: "Artifact file not found" });
  }
  sendJson(res, 200, {
    id: artifact.id,
    displayId: artifact.displayId ?? null,
    phase: artifact.phase ?? null,
    title: artifact.title ?? null,
    agent: artifact.agent ?? null,
    decision: artifact.decision ?? null,
    status: artifact.status ?? null,
    createdAt: artifact.createdAt ?? null,
    sha256: artifact.sha256 ?? null,
    path: artifact.path,
    content: redactSecrets(content),
  });
}

async function buildState(ctx) {
  const issues = [];
  const prs = await safeGhPRs();
  const dashboardPrs = prs.map(normalizePrForDashboard);
  const ghIssues = await safeGhIssues();
  issues.push(...ghIssues.map((issue) => ({
    id: `gh-${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels?.map((label) => label.name) ?? [],
    url: issue.url,
    source: "github",
  })));

  const hydrated = [];
  for (const issue of issues) {
    const local = ctx.state.issues[issue.id] ?? {};
    const { derived, spec, linkedPr, automationSummary, eligibility } = await deriveIssueState({
      root: ROOT,
      issue,
      prs: dashboardPrs,
      localIssue: local,
    });
    const relatedPrs = dashboardPrs.filter((pr) =>
      pr.relatedIssues?.some((number) => String(number) === String(issue.number)),
    );
    hydrated.push({
      ...issue,
      spec,
      linkedPr,
      relatedPrs,
      automationSummary,
      eligibility,
      requirementsIssueInputSha: derived.requirements?.issueInputSha ?? null,
      phases: buildPhaseView(issue, local, derived),
      local: {
        approvals: local.approvals ?? {},
        feedback: local.feedback ?? [],
        reflections: local.reflections ?? [],
        events: local.events ?? [],
      },
    });
  }

  return {
    mode: {
      writeEnabled: false,
      agentRunsEnabled: Boolean(ctx.args.allowAgentRuns),
      demoEnabled: false,
      host: "127.0.0.1",
    },
    security: {
      nonce: currentNonce(ctx.state),
    },
    phases: PHASES,
    prs: dashboardPrs,
    issues: hydrated,
  };
}

function normalizePrForDashboard(pr) {
  const closingIssues = pr.closingIssuesReferences?.map((ref) => ref.number) ?? [];
  const relatedIssues = uniqueNumbers([
    ...closingIssues,
    ...issueRefsFromTitle(pr.title),
    ...issueRefsFromBody(pr.body),
  ]);
  const status = pr.mergedAt || pr.state === "MERGED"
    ? "merged"
    : pr.state === "CLOSED"
      ? "closed"
      : pr.isDraft
        ? "draft"
        : "open";
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    status,
    statusLabel: status.toUpperCase(),
    isDraft: pr.isDraft,
    mergedAt: pr.mergedAt ?? null,
    closedAt: pr.closedAt ?? null,
    mergeStateStatus: pr.mergeStateStatus,
    closingIssues,
    relatedIssues,
  };
}

function issueRefsFromTitle(text) {
  return [...String(text ?? "").matchAll(/(?:^|[^\w])#(\d+)\b/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

function issueRefsFromBody(text) {
  return [...String(text ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#(\d+)\b/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

function uniqueNumbers(values) {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

async function safeGhIssues() {
  try {
    const config = await getConfig();
    return await ghJson([
      "issue",
      "list",
      "--repo",
      config.repository,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,body,labels,comments,url",
    ]);
  } catch {
    return [];
  }
}

async function safeGhPRs() {
  try {
    const config = await getConfig();
    return await ghJson([
      "pr",
      "list",
      "--repo",
      config.repository,
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,title,body,url,state,isDraft,mergedAt,closedAt,mergeStateStatus,closingIssuesReferences",
    ]);
  } catch {
    return [];
  }
}

let historyCache = { at: 0, data: null };

async function buildHistory() {
  const now = Date.now();
  if (historyCache.data && now - historyCache.at < 20_000) return historyCache.data;
  const closed = await safeGhClosedIssues();
  const data = {
    closedIssues: closed.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      closedAt: issue.closedAt ?? null,
      labels: (issue.labels ?? []).map((label) => label.name),
    })),
  };
  historyCache = { at: now, data };
  return data;
}

async function safeGhClosedIssues() {
  try {
    const config = await getConfig();
    return await ghJson([
      "issue",
      "list",
      "--repo",
      config.repository,
      "--state",
      "closed",
      "--limit",
      "50",
      "--json",
      "number,title,url,closedAt,labels",
    ]);
  } catch {
    return [];
  }
}

async function serveStatic(_req, res, rel) {
  const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(UI_DIR, safeRel);
  if (!file.startsWith(UI_DIR)) return res.writeHead(403).end("Forbidden");
  const content = await fs.readFile(file);
  const ext = path.extname(file);
  const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "application/octet-stream";
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(content);
}

function requireApiRequest(req, token) {
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw httpError(403, "Bad host");
  if (req.headers["x-dashboard-token"] !== token) throw httpError(403, "Bad dashboard token");
}

function requireMutation(req) {
  if (req.headers["x-dashboard-action"] !== "1") throw httpError(400, "Missing action header");
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw httpError(415, "Expected JSON");
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin)) {
    throw httpError(403, "Bad origin");
  }
}

export function rotateNonce(state) {
  state.security ??= {};
  state.security.nonce = randomBytes(16).toString("hex");
  return state.security.nonce;
}

function currentNonce(state) {
  if (!state.security?.nonce) return rotateNonce(state);
  return state.security.nonce;
}

export function shouldRateLimit(map, key, now = Date.now()) {
  // Bound memory: evict keys with no activity inside the window, and hard-cap the
  // number of tracked keys so a client with the token cannot grow the map without
  // limit by spamming distinct issue/phase keys (memory DoS).
  if (map.size >= RATE_LIMIT_MAX_KEYS) sweepRateLimits(map, now);
  const prior = Array.isArray(map.get(key)) ? map.get(key) : [];
  const recent = prior.filter((timestamp) => now - timestamp < 60_000);
  const last = recent.at(-1);
  if (last !== undefined && now - last < 3_000) {
    map.set(key, recent);
    return true;
  }
  if (recent.length >= 10) {
    map.set(key, recent);
    return true;
  }
  recent.push(now);
  map.set(key, recent);
  return false;
}

const RATE_LIMIT_MAX_KEYS = 1_000;

// Drop keys whose timestamps are all outside the 60s window; if still over the
// cap afterwards, evict the least-recently-used keys until under it.
function sweepRateLimits(map, now) {
  for (const [key, timestamps] of map) {
    const list = Array.isArray(timestamps) ? timestamps : [];
    if (list.length === 0 || list.every((timestamp) => now - timestamp >= 60_000)) {
      map.delete(key);
    }
  }
  if (map.size < RATE_LIMIT_MAX_KEYS) return;
  const byRecency = [...map.entries()].sort(
    (a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0),
  );
  for (const [key] of byRecency) {
    if (map.size < RATE_LIMIT_MAX_KEYS) break;
    map.delete(key);
  }
}

function blockingEligibilityReasonsForRecovery(issue) {
  const reasons = issue.eligibility?.reasons ?? [];
  if (!reasons.length) return [];
  const labels = new Set((issue.labels ?? []).map((label) => String(label).toLowerCase()));
  const onlyBlockedOrNeedsHumanLabel =
    labels.has("blocked") || labels.has("needs-human")
      ? reasons.every((reason) =>
          ["STOPPED", "EXCLUDED_LABEL"].includes(reason?.code) &&
          /`?(blocked|needs-human)`?/i.test(String(reason?.message ?? "")),
        )
      : false;
  return onlyBlockedOrNeedsHumanLabel ? [] : reasons;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function setSecurityHeaders(res) {
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32_000) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") out.port = argv[++i];
    else if (arg === "--host") out.host = argv[++i];
    else if (arg === "--allow-agent-runs") out.allowAgentRuns = true;
    else if (arg === "--agent-command") out.agentCommand = argv[++i];
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
