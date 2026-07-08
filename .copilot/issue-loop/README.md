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

Open the printed localhost URL. The dashboard shows real open repository issues; actions remain local/read-only unless the loop is explicitly enabled.

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

1. **Monitor**: list open issues. The dashboard shows all of them; implementation still requires an allowlist label such as `automate`.
2. **Requirements critique**: all open issues can receive a requirements critique marker. Clear requirements proceed to spec drafting; ambiguous requirements ask for human input.
3. **Spec**: create or refresh `docs/automation/specs/issue-<number>-<slug>/`.
4. **Adversarial review**: use a different model family than the architect.
5. **Spec review gate**: continue automatically if the adversarial review has no open questions; ask for human input only when it raises blockers/questions.
6. **Implementation**: isolated worktree, deterministic branch, draft PR.
7. **Agent PR review**: an agent reviewer critiques the PR and iterates with the developer agent until no blocking findings remain.
8. **Verification**: run configured commands, redact logs, require UX screenshots for UI changes.
9. **Finalization**: mark ready for human review and request configured reviewers only after current-head verification passes.
10. **Human PR review/merge**: human only.

## Trigger options

Recommended first: run the local watcher and use the GitHub `automate` label as implementation opt-in. Requirements-only triage for all open issues is available with `triageAllOpenIssues`, but it is off by default and still skips excluded/stop-labeled issues.

Hosted GitHub Actions, if added later, should be metadata-only: `issues: write`, `contents: read`, no Copilot credentials, no implementation, no `pull_request_target`.

## Local dashboard

The dashboard is a dependency-free localhost app served by:

```bash
pnpm automation:dashboard -- --port 8787
```

It shows:

- Real open GitHub issues from this repo, read-only by default. There is no built-in demo issue.
- Each automation phase and its current artifacts.
- Local approvals that record review decisions. For real GitHub issues, implementation still requires the trusted hash-bound spec approval marker.
- Feedback prompts that can run a reviewed text-only agent wrapper only when the server is started with `--allow-agent-runs --agent-command`.
- A self-reflection phase that summarizes loop history and human feedback.

Security defaults:

- Binds to `127.0.0.1`.
- Requires a per-session API token.
- Renders GitHub/spec content as text, not HTML.
- Does not write to GitHub.
- Stores dashboard state in ignored `.copilot-issue-loop/dashboard-state.json`.
- Agent runs are disabled unless an explicit reviewed text-only command template is provided. The current implementation only permits the safe `cat {promptFile}` command.

Example local text echo:

```bash
pnpm automation:dashboard -- --allow-agent-runs --agent-command "cat {promptFile}"
```

Do not point this at Copilot directly until a dedicated text-only wrapper exists and has been reviewed. Commands that grant tools, MCP servers, shell, git, GitHub, or repository file access are intentionally rejected.

## Spec approval markers

Approval markers are intentionally bound to a specific spec path and content hash so stale approvals cannot unlock a changed plan:

```md
<!-- verbatim-ai:spec-approval:v1 issue=3 approvedBy=@maintainer path=docs/automation/specs/issue-0003-demo/spec.md sha=<sha256> -->
```

The next human gate is PR review. The old spec-approval marker format is still documented for manual override workflows, but the default loop only blocks before implementation when the adversarial spec review raises open questions or concerns requiring maintainer input.

## Requirements critique markers

Requirements critique markers are idempotent and bound to the current issue title/body/comments hash:

```md
<!-- verbatim-ai:requirements:v1 issue=18 status=clear issueInputSha=<sha256> artifactSha=<sha256> -->
```

If the critique is `clear`, the loop may proceed to spec drafting without a human requirements gate. If the adversarial spec review is clear, implementation may proceed automatically to a draft PR. Human review happens at the PR stage after agent PR review, verification, and required screenshots.

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
