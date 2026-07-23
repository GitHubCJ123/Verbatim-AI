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
  maxPrReviewIterations: 2,
  triageAllOpenIssues: false,
  requiredLabels: ["automate"],
  excludedLabels: ["wontfix", "blocked", "needs-human"],
  automationLabels: {
    inProgress: "automation-in-progress",
    readyForReview: "ready-for-review",
    needsHuman: "needs-human",
    specApproved: "spec-approved",
  },
  branchPrefix: "copilot/issue-",
  worktrees: {
    root: ".copilot-issue-loop/worktrees",
    cleanupMergedPrBranches: true,
  },
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
    requirementsCritic: { persona: "requirements critic", model: "gpt-5.5" },
    architect: { persona: "experienced software architect", model: "gpt-5.5" },
    adversarialReviewer: {
      persona: "skeptical senior reviewer",
      model: "claude-opus-4.8",
      mustDifferFrom: "architect",
    },
    implementer: { model: "claude-sonnet-5" },
    agentPrReviewer: {
      persona: "skeptical PR reviewer focused on correctness, security, tests, and UX regressions",
      model: "gpt-5.5",
    },
    verifier: { model: "gpt-5.5" },
    finalizer: { model: "gpt-5.5" },
    selfReflector: { model: "claude-opus-4.8" },
  },
  gates: {
    requireHumanOnSpecReviewQuestions: true,
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
    baseArgs: ["--add-dir", "{worktree}"],
    allowTools: ["view", "write", "str_replace"],
    implementerTools: ["view", "write", "str_replace", "shell"],
    denyTools: [
      "shell(gh:*)",
      "shell(git push:*)",
      "shell(git commit:*)",
      "shell(git reset:*)",
      "shell(git checkout:*)",
      "shell(git switch:*)",
      "shell(git rebase:*)",
      "shell(git merge:*)",
      "shell(curl:*)",
      "shell(wget:*)",
      "shell(ssh:*)",
      "shell(scp:*)",
      "shell(sudo:*)",
    ],
    readOnlyRoles: ["architect", "adversarialReviewer", "agentPrReviewer", "requirementsCritic"],
    readOnlyTools: ["view"],
    timeoutMinutes: 15,
  },
  recovery: {
    // On by default: once the loop itself is enabled, a blocked/needs-human
    // phase attempts bounded multi-model recovery before escalating to a human.
    // Set to false to restore the original single-model, stop-on-block behavior.
    enabled: true,
    defaultPolicy: "conservative",
    budgets: {
      maxModelCallsPerIssue: 20,
      maxModelCallsPerPhase: 6,
      maxCouncilRounds: 1,
      maxImplementationAttempts: 2,
      maxVerifierRepairAttempts: 2,
      maxWallClockMinutesPerIssue: 60,
    },
    locking: { enabled: true, ttlMinutes: 30 },
    phases: {
      requirements: {
        enabled: true,
        allowedTiers: ["primary", "requirementsCritic"],
        // The AI council may clear a regex-flagged non-security issue so the
        // pipeline is not a dead-end. Security-sensitive issues (narrowly
        // detected) can still never be AI-cleared.
        allowAiDowngrade: true,
        allowAiDowngradeForSecuritySensitive: false,
      },
      "spec-review": {
        enabled: true,
        allowedTiers: ["primary", "diverseRetry", "council"],
        securityVeto: true,
      },
      implementation: {
        enabled: true,
        allowedTiers: ["primary", "sequentialRetry"],
        maxAttempts: 2,
        branchStrategy: "incremental-after-pr",
      },
      verification: {
        enabled: true,
        allowedTiers: ["repairOnly"],
        verifierAuthoritative: true,
      },
    },
    rosters: {
      requirements: ["gpt-5.5", "claude-opus-4.8"],
      "spec-review": ["claude-opus-4.8", "gpt-5.5"],
      implementation: ["claude-sonnet-5", "gpt-5.5"],
    },
  },
};

const RECOVERY_TIERS = new Set([
  "primary",
  "requirementsCritic",
  "diverseRetry",
  "council",
  "sequentialRetry",
  "repairOnly",
]);
const RECOVERY_BRANCH_STRATEGIES = new Set(["incremental-after-pr", "replace-before-pr"]);
const RECOVERY_DIVERSITY_TIERS = new Set(["diverseRetry", "council"]);
// A model token flows verbatim to `spawnFile(command, [..., "--model", model])`.
// spawnFile runs WITHOUT a shell, so this can never be shell injection, but a
// token beginning with "-" or containing whitespace could be misparsed by the
// CLI as a separate flag. Constrain roster/agent model tokens to a safe charset
// (letters, digits, and . _ : / -) that cannot smuggle an extra argument.
const SAFE_MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function isValidQuorum(quorum) {
  return (
    quorum === "all" ||
    quorum === "unanimous" ||
    quorum === "majority" ||
    (Number.isInteger(quorum) && quorum >= 1)
  );
}

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
  errors.push(...recoveryConfigErrors(config.recovery));
  if (errors.length) throw new Error(`Invalid issue-loop config:\n- ${errors.join("\n- ")}`);
}

export function recoveryConfigErrors(recovery) {
  const errors = [];
  if (recovery === undefined || recovery === null) return errors;
  if (!isObject(recovery)) return ["recovery must be an object"];
  if (typeof recovery.enabled !== "boolean") errors.push("recovery.enabled must be a boolean");

  const budgets = recovery.budgets ?? {};
  if (!isObject(budgets)) {
    errors.push("recovery.budgets must be an object");
  } else {
    for (const key of [
      "maxModelCallsPerIssue",
      "maxModelCallsPerPhase",
      "maxCouncilRounds",
      "maxImplementationAttempts",
      "maxVerifierRepairAttempts",
      "maxWallClockMinutesPerIssue",
    ]) {
      const value = budgets[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        errors.push(`recovery.budgets.${key} must be a positive integer`);
      }
    }
  }

  const locking = recovery.locking ?? {};
  if (locking.ttlMinutes !== undefined && (!Number.isInteger(locking.ttlMinutes) || locking.ttlMinutes < 1)) {
    errors.push("recovery.locking.ttlMinutes must be a positive integer");
  }

  const phases = recovery.phases ?? {};
  if (!isObject(phases)) {
    errors.push("recovery.phases must be an object");
  } else {
    for (const [phaseId, phase] of Object.entries(phases)) {
      if (!isObject(phase)) {
        errors.push(`recovery.phases.${phaseId} must be an object`);
        continue;
      }
      for (const tier of phase.allowedTiers ?? []) {
        if (!RECOVERY_TIERS.has(tier)) {
          errors.push(`recovery.phases.${phaseId}.allowedTiers has unknown tier: ${tier}`);
        }
      }
      if (
        phase.branchStrategy !== undefined &&
        !RECOVERY_BRANCH_STRATEGIES.has(phase.branchStrategy)
      ) {
        errors.push(
          `recovery.phases.${phaseId}.branchStrategy must be one of ${[...RECOVERY_BRANCH_STRATEGIES].join(", ")}`,
        );
      }
      if (phase.quorum !== undefined && !isValidQuorum(phase.quorum)) {
        errors.push(
          `recovery.phases.${phaseId}.quorum must be "all", "unanimous", "majority", or a positive integer`,
        );
      }
    }
    // Hard safety invariant baked into config: AI may never clear a
    // security-sensitive requirements issue, regardless of user config.
    if (phases.requirements?.allowAiDowngradeForSecuritySensitive === true) {
      errors.push(
        "recovery.phases.requirements.allowAiDowngradeForSecuritySensitive must be false; AI may not clear security-sensitive issues",
      );
    }
  }

  const rosters = recovery.rosters ?? {};
  if (!isObject(rosters)) {
    errors.push("recovery.rosters must be an object");
  } else {
    for (const [phaseId, roster] of Object.entries(rosters)) {
      if (!Array.isArray(roster) || roster.some((model) => typeof model !== "string")) {
        errors.push(`recovery.rosters.${phaseId} must be an array of model strings`);
        continue;
      }
      for (const model of roster) {
        if (model !== "auto" && !SAFE_MODEL_TOKEN.test(model)) {
          errors.push(
            `recovery.rosters.${phaseId} has an unsafe model token: ${JSON.stringify(String(model).slice(0, 60))}`,
          );
        }
      }
      const allowedTiers = phases[phaseId]?.allowedTiers ?? [];
      const needsDiversity = allowedTiers.some((tier) => RECOVERY_DIVERSITY_TIERS.has(tier));
      if (needsDiversity) {
        const families = new Set(roster.map(modelFamily));
        if (families.size < 2) {
          errors.push(
            `recovery.rosters.${phaseId} must span at least two model families for diverseRetry/council tiers`,
          );
        }
      }
    }
  }
  return errors;
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
