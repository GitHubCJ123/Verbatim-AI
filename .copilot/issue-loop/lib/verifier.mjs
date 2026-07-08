import fs from "node:fs/promises";
import path from "node:path";
import { spawnFile, parseCommand } from "./process.mjs";
import { changedFiles, hasUiChanges } from "./git.mjs";
import { findSecretLikeText, redactSecrets, truncateForComment } from "./redaction.mjs";

const DENIED_TOKENS = [
  "gh pr merge",
  "git push --force",
  "git reset --hard",
  "gh secret",
  "gh release",
  "gh workflow run",
  "rm -rf /",
  "curl ",
  "env",
  "printenv",
];

export async function runVerification(config, cwd) {
  const env = await credentialFreeEnv(cwd);
  const baseRef = `origin/${config.baseBranch ?? "main"}`;
  const commands = [
    config.verification.installCommand,
    ...config.verification.commands,
    ...(config.verification.runHeavyCommands ? config.verification.heavyCommands : []),
  ].filter(Boolean);

  if (!config.verification.allowHostExecution) {
    if (!config.verification.sandboxCommand) {
      return failClosedSandboxRequired(cwd, config);
    }
    assertAllowedSandboxCommand(config.verification.sandboxCommand);
    const [bin, ...args] = parseCommand(
      config.verification.sandboxCommand.replace("{worktree}", cwd),
    );
    const result = await spawnFile(bin, args, { cwd, env });
    const files = await changedFiles(cwd, baseRef);
    const diffResult = await spawnFile("git", ["diff", `${baseRef}...HEAD`], { cwd, env });
    const secretFindings = findSecretLikeText(diffResult.stdout);
    return {
      ok: result.code === 0 && secretFindings.length === 0,
      results: [
        {
          command: config.verification.sandboxCommand,
          code: result.code,
          stdout: truncateForComment(result.stdout, 6000),
          stderr: truncateForComment(result.stderr, 6000),
        },
      ],
      secretFindings,
      screenshotsRequired: config.gates.requireScreenshotsForUxChanges && hasUiChanges(files),
      files,
    };
  }

  const results = [];
  for (const command of commands) {
    assertAllowedCommand(command);
    const [bin, ...args] = parseCommand(command);
    const result = await spawnFile(bin, args, { cwd, env });
    results.push({
      command,
      code: result.code,
      stdout: truncateForComment(result.stdout, 6000),
      stderr: truncateForComment(result.stderr, 6000),
    });
    if (result.code !== 0) break;
  }

  async function failClosedSandboxRequired(cwd, config) {
    const files = await changedFiles(cwd, baseRef);
    return {
      ok: false,
      results: [
        {
          command: "sandbox preflight",
          code: 1,
          stdout: "",
          stderr:
            "Verification refused to execute PR-controlled install/test/build scripts on the maintainer host. Configure verification.sandboxCommand (docker/podman/devcontainer) or explicitly set verification.allowHostExecution=true after accepting the risk.",
        },
      ],
      secretFindings: [],
      screenshotsRequired: config.gates.requireScreenshotsForUxChanges && hasUiChanges(files),
      files,
    };
  }

  const diffResult = await spawnFile("git", ["diff", `${baseRef}...HEAD`], { cwd, env });
  const secretFindings = findSecretLikeText(diffResult.stdout);
  const files = await changedFiles(cwd, baseRef);
  const screenshotsRequired = config.gates.requireScreenshotsForUxChanges && hasUiChanges(files);

  return {
    ok: results.every((result) => result.code === 0) && secretFindings.length === 0,
    results,
    secretFindings,
    screenshotsRequired,
    files,
  };
}

export async function credentialFreeEnv(cwd) {
  const home = path.join(cwd, ".copilot-issue-loop", "verifier-home");
  const tmp = path.join(cwd, ".copilot-issue-loop", "tmp");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(home, ".gitconfig"), "", { flag: "a" });
  await fs.writeFile(path.join(home, ".npmrc"), "", { flag: "a" });

  const keep = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    GH_CONFIG_DIR: path.join(home, ".config", "gh"),
    GITHUB_CONFIG_DIR: path.join(home, ".config", "github"),
    NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    CI: "true",
    NO_COLOR: "1",
  };
}

export function verificationComment({ pr, issue, head, status, report }) {
  const marker = `<!-- verbatim-ai:verify:v1 pr=${pr} issue=${issue} head=${head} status=${status} -->`;
  return `${marker}\n\n## Automation verification: ${status}\n\n${redactSecrets(report)}`;
}

export function assertAllowedCommand(command) {
  const normalized = command.trim();
  for (const denied of DENIED_TOKENS) {
    if (normalized.includes(denied)) {
      throw new Error(`Denied verification command: ${command}`);
    }
  }
  if (!/^(corepack |pnpm |npm |cargo |git diff --check)/.test(normalized)) {
    throw new Error(`Command is not in the verifier allowlist: ${command}`);
  }
}

export function assertAllowedSandboxCommand(command) {
  const normalized = command.trim();
  for (const denied of DENIED_TOKENS) {
    if (normalized.includes(denied)) {
      throw new Error(`Denied sandbox command: ${command}`);
    }
  }
  if (!/^(docker |podman |devcontainer |nix develop )/.test(normalized)) {
    throw new Error(
      "verification.sandboxCommand must start with docker, podman, devcontainer, or nix develop",
    );
  }
}
