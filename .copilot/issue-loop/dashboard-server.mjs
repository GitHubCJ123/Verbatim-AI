#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ghJson } from "./lib/github.mjs";
import {
  applyApproval,
  buildPhaseView,
  demoIssue,
  deriveIssueState,
  ensureDashboardState,
  feedbackPrompt,
  PHASES,
  recordFeedback,
  recordReflection,
  reflectionPrompt,
  runTextAgent,
  runtimeDirFor,
  saveDashboardState,
  statePathFor,
} from "./lib/dashboard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UI_DIR = path.join(ROOT, ".copilot/issue-loop/ui");

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

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, { args, token, port, host, statePath, get state() { return state; }, setState: (next) => { state = next; } });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
  const body = await readJson(req);
  const approve = url.pathname.match(/^\/api\/issues\/([^/]+)\/phases\/([^/]+)\/approve$/);
  if (approve) {
    const [, issueId, phaseId] = approve;
    const stateIssue = applyApproval(ctx.state, issueId, phaseId, body);
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 200, { ok: true, issue: stateIssue, state: await buildState(ctx) });
    return;
  }

  const feedback = url.pathname.match(/^\/api\/issues\/([^/]+)\/phases\/([^/]+)\/feedback$/);
  if (feedback) {
    const [, issueId, phaseId] = feedback;
    const dashboard = await buildState(ctx);
    const issue = dashboard.issues.find((item) => item.id === issueId);
    if (!issue) return sendJson(res, 404, { error: "Issue not found" });
    const phase = issue.phases.find((item) => item.id === phaseId);
    const prompt = feedbackPrompt(issue, phaseId, body.feedback ?? "", phase?.output ?? "");
    const agentResult = await runTextAgent({
      prompt,
      allowAgentRuns: Boolean(ctx.args.allowAgentRuns && body.runAgent),
      agentCommand: ctx.args.agentCommand,
    });
    recordFeedback(ctx.state, issueId, phaseId, body.feedback ?? "", agentResult);
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 200, { ok: true, agentResult, state: await buildState(ctx) });
    return;
  }

  const reflect = url.pathname.match(/^\/api\/issues\/([^/]+)\/reflect$/);
  if (reflect) {
    const [, issueId] = reflect;
    const dashboard = await buildState(ctx);
    const issue = dashboard.issues.find((item) => item.id === issueId);
    if (!issue) return sendJson(res, 404, { error: "Issue not found" });
    const prompt = reflectionPrompt(issue, issue.phases, issue.local.feedback ?? []);
    const result = await runTextAgent({
      prompt,
      allowAgentRuns: Boolean(ctx.args.allowAgentRuns && body.runAgent),
      agentCommand: ctx.args.agentCommand,
    });
    recordReflection(ctx.state, issueId, result);
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 200, { ok: true, result, state: await buildState(ctx) });
    return;
  }

  if (url.pathname === "/api/demo/reset") {
    delete ctx.state.issues["demo-9001"];
    await saveDashboardState(ctx.statePath, ctx.state);
    sendJson(res, 200, { ok: true, state: await buildState(ctx) });
    return;
  }

  sendJson(res, 404, { error: "Unknown endpoint" });
}

async function buildState(ctx) {
  const issues = [demoIssue()];
  const prs = await safeGhPRs();
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
    const { derived, spec, linkedPr } = await deriveIssueState({ root: ROOT, issue, prs, localIssue: local });
    hydrated.push({
      ...issue,
      spec,
      linkedPr,
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
      demoEnabled: true,
      host: "127.0.0.1",
    },
    phases: PHASES,
    issues: hydrated,
  };
}

async function safeGhIssues() {
  try {
    return await ghJson([
      "issue",
      "list",
      "--repo",
      "GitHubCJ123/Verbatim-AI",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      "number,title,body,labels,url",
    ]);
  } catch {
    return [];
  }
}

async function safeGhPRs() {
  try {
    return await ghJson([
      "pr",
      "list",
      "--repo",
      "GitHubCJ123/Verbatim-AI",
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,title,url,isDraft,mergeStateStatus,closingIssuesReferences",
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
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw new Error("Bad host");
  if (req.headers["x-dashboard-token"] !== token) throw new Error("Bad dashboard token");
}

function requireMutation(req) {
  if (req.headers["x-dashboard-action"] !== "1") throw new Error("Missing action header");
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new Error("Expected JSON");
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin)) {
    throw new Error("Bad origin");
  }
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
