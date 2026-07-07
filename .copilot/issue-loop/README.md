# Local Copilot issue loop

This directory contains a self-hosted, human-gated automation loop for turning explicitly opted-in GitHub issues into verified draft PRs.

The loop is intentionally local-first:

- Uses the maintainer's existing `gh` and Copilot CLI auth.
- Does not store tokens in the repository.
- Opens draft PRs only.
- Never merges PRs.
- Requires hash-bound spec approval before implementation.

## Quick start

```bash
cp .copilot/issue-loop/config.example.json .copilot/issue-loop/config.local.json
$EDITOR .copilot/issue-loop/config.local.json
node .copilot/issue-loop/issue-loop.mjs --once --config .copilot/issue-loop/config.local.json
```

The example config is disabled and dry-run by default. Add `.copilot-issue-loop/STOP` to pause all phases.

## How to trigger it

The loop is opt-in. It does not act on every new issue.

For a visual control room, start the local dashboard:

```bash
pnpm automation:dashboard
```

Open the printed localhost URL. The dashboard includes a local demo issue (`DEMO-9001`) so you can test approvals, feedback, and self-reflection without touching GitHub.

1. Copy and edit local config:

   ```bash
   cp .copilot/issue-loop/config.example.json .copilot/issue-loop/config.local.json
   ```

2. In `config.local.json`, set:

   ```json
   {
     "enabled": true,
     "dryRun": true,
     "reviewers": ["your-github-handle"]
   }
   ```

   Keep `dryRun: true` for the first run. The default required label is `automate`.

3. Add the `automate` label to the issue you want the loop to consider.

4. Run one dry-run tick:

   ```bash
   pnpm automation:issues -- --once --config .copilot/issue-loop/config.local.json
   ```

5. If the dry run selects the expected issue, set `dryRun: false` and run:

   ```bash
   pnpm automation:issues -- --once --config .copilot/issue-loop/config.local.json
   ```

6. For continuous polling on a maintainer machine:

   ```bash
   pnpm automation:issues -- --watch --config .copilot/issue-loop/config.local.json
   ```

The first real run creates or refreshes the issue spec under `docs/automation/specs/`, posts a claim/spec marker, and then stops at the human spec gate.

To approve implementation, add a trusted `spec-approval` marker bound to the spec hash, or use the configured approval flow described below. After implementation, the loop still opens draft PRs only and never merges.

## Workflow

1. **Monitor**: find open issues with an allowlist label such as `automate`.
2. **Requirements critique**: stop and ask for human input if the issue is ambiguous, missing acceptance criteria, or involves secrets/external access.
3. **Spec**: create or refresh `docs/automation/specs/issue-<number>-<slug>/`.
4. **Adversarial review**: use a different model family than the architect.
5. **Human spec gate**: require a trusted `spec-approval` marker bound to the current spec path and SHA-256 hash. A label alone is never enough.
6. **Implementation**: isolated worktree, deterministic branch, draft PR.
7. **Verification**: run configured commands, redact logs, require UX screenshots for UI changes.
8. **Finalization**: mark ready for review and request configured reviewers only after current-head verification passes.
9. **Merge**: human only.

## Trigger options

Recommended first: run the local watcher and use the GitHub `automate` label as opt-in.

Hosted GitHub Actions, if added later, should be metadata-only: `issues: write`, `contents: read`, no Copilot credentials, no implementation, no `pull_request_target`.

## Local dashboard

The dashboard is a dependency-free localhost app served by:

```bash
pnpm automation:dashboard -- --port 8787
```

It shows:

- Real open GitHub issues from this repo, read-only by default.
- A built-in demo issue for safe testing.
- Each automation phase and its current artifacts.
- Local approvals that move the demo/local state forward.
- Feedback prompts that can run a reviewed text-only agent wrapper only when the server is started with `--allow-agent-runs --agent-command`.
- A self-reflection phase that summarizes loop history and human feedback.

Security defaults:

- Binds to `127.0.0.1`.
- Requires a per-session API token.
- Renders GitHub/spec content as text, not HTML.
- Does not write to GitHub.
- Stores dashboard state in ignored `.copilot-issue-loop/dashboard-state.json`.
- Agent runs are disabled unless an explicit reviewed text-only command template is provided. The current implementation only permits the demo-safe `cat {promptFile}` command.

Example demo-only text agent:

```bash
pnpm automation:dashboard -- --allow-agent-runs --agent-command "cat {promptFile}"
```

Do not point this at Copilot directly until a dedicated text-only wrapper exists and has been reviewed. Commands that grant tools, MCP servers, shell, git, GitHub, or repository file access are intentionally rejected.

## Spec approval markers

Approval markers are intentionally bound to a specific spec path and content hash so stale approvals cannot unlock a changed plan:

```md
<!-- verbatim-ai:spec-approval:v1 issue=3 approvedBy=@maintainer path=docs/automation/specs/issue-0003-demo/spec.md sha=<sha256> -->
```

The loop verifies the comment author has write, maintain, or admin permission on the repository, or is listed in `trustedApprovers`. It ignores labels by themselves and ignores markers whose `issue`, `path`, or `sha` does not match the current spec.

The architect and adversarial reviewer run in read-only mode by default. Issue text is wrapped as untrusted input, and the driver writes only controlled spec scaffold files under `docs/automation/specs/`.

## Verification sandbox

Verification runs PR-controlled code, so the default verifier refuses to execute install/test/build scripts directly on a maintainer host. Configure a real sandbox command before enabling finalization:

```json
{
  "verification": {
    "allowHostExecution": false,
    "sandboxCommand": "docker run --rm --network none -v {worktree}:/repo -w /repo node:22 bash -lc 'corepack enable && pnpm install --frozen-lockfile --ignore-scripts && pnpm test && pnpm build'"
  }
}
```

Set `allowHostExecution=true` only for trusted branches after explicitly accepting the risk that package scripts can read local files or use network access.
