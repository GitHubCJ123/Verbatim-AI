import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CONFIG = {
  enabled: false,
  dryRun: true,
  repository: "GitHubCJ123/Verbatim-AI",
  baseBranch: "main",
  pollIntervalSeconds: 300,
  maxConcurrentIssues: 1,
  maxIssuesPerTick: 1,
  requiredLabels: ["automate"],
  excludedLabels: ["wontfix", "blocked", "needs-human"],
  automationLabels: {
    inProgress: "automation-in-progress",
    readyForReview: "ready-for-review",
    needsHuman: "needs-human",
    specApproved: "spec-approved",
  },
  branchPrefix: "copilot/issue-",
  reviewers: [],
  teamReviewers: [],
  trustedApprovers: [],
  claimTtlMinutes: 240,
  stop: {
    env: "COPILOT_ISSUE_LOOP_STOP",
    file: ".copilot-issue-loop/STOP",
    labels: ["automation-stop", "blocked"],
  },
  agents: {
    architect: { persona: "experienced software architect", model: "gpt-5.5" },
    adversarialReviewer: {
      persona: "skeptical senior reviewer",
      model: "claude-opus-4.8",
      mustDifferFrom: "architect",
    },
    implementer: { model: "claude-sonnet-5" },
    verifier: { model: "gpt-5.5" },
  },
  gates: {
    requireHumanSpecApproval: true,
    requireHumanMerge: true,
    requireScreenshotsForUxChanges: true,
  },
  verification: {
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    commands: ["pnpm lint", "pnpm test", "pnpm build"],
    heavyCommands: ["pnpm tauri build"],
    runHeavyCommands: false,
    allowHostExecution: false,
    sandboxCommand: "",
    timeoutMinutes: 45,
  },
  copilot: {
    command: "copilot",
    model: "auto",
    baseArgs: ["-p", "--add-dir", "{worktree}"],
    allowTools: ["view", "rg", "glob", "apply_patch"],
    readOnlyRoles: ["architect", "adversarialReviewer"],
    readOnlyTools: ["view", "rg", "glob"],
  },
};

export async function loadConfig(filePath) {
  let user = {};
  if (filePath) {
    const raw = await fs.readFile(filePath, "utf8");
    user = JSON.parse(raw);
  }
  const config = mergeConfig(DEFAULT_CONFIG, user);
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  const errors = [];
  if (!/^[^/]+\/[^/]+$/.test(config.repository)) errors.push("repository must be owner/name");
  if (config.maxConcurrentIssues < 1) errors.push("maxConcurrentIssues must be at least 1");
  if (config.maxIssuesPerTick < 1) errors.push("maxIssuesPerTick must be at least 1");
  if (!config.requiredLabels?.length) errors.push("requiredLabels must not be empty");
  const architect = config.agents?.architect?.model;
  const reviewer = config.agents?.adversarialReviewer?.model;
  if (!architect || !reviewer) errors.push("architect and adversarialReviewer models are required");
  if (architect === reviewer || modelFamily(architect) === modelFamily(reviewer)) {
    errors.push("adversarialReviewer model must differ from architect model/family");
  }
  if (config.gates?.requireHumanMerge !== true) {
    errors.push("requireHumanMerge must be true; automation must not merge PRs");
  }
  if (errors.length) throw new Error(`Invalid issue-loop config:\n- ${errors.join("\n- ")}`);
}

export function modelFamily(model) {
  const m = String(model).toLowerCase();
  if (m.startsWith("gpt") || m.includes("openai")) return "openai";
  if (m.startsWith("claude") || m.includes("anthropic")) return "anthropic";
  if (m.startsWith("gemini") || m.includes("google")) return "google";
  return m.split(/[-_:]/)[0] || m;
}

export async function stopRequested(config, cwd, labels = []) {
  if (config.stop?.env && process.env[config.stop.env]) return `env ${config.stop.env}`;
  if (config.stop?.file) {
    const stopPath = path.resolve(cwd, config.stop.file);
    try {
      await fs.access(stopPath);
      return `file ${config.stop.file}`;
    } catch {
      // not present
    }
  }
  const stopLabels = new Set(config.stop?.labels ?? []);
  const found = labels.find((label) => stopLabels.has(label));
  return found ? `label ${found}` : null;
}

function mergeConfig(base, user) {
  if (Array.isArray(base) || Array.isArray(user)) return user ?? base;
  if (isObject(base) && isObject(user)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(user)) {
      out[key] = mergeConfig(base[key], value);
    }
    return out;
  }
  return user === undefined ? base : user;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
