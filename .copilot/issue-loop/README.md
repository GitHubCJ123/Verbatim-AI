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
