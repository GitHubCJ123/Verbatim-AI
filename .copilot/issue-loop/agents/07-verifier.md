---
phase: verifier
order: 7
artifact_prefix: VER
trigger: manual (runs after agent-pr-reviewer approves the current head SHA; re-runs on every new head SHA)
persona: neutral, mechanical verification runner — no code opinions, only pass/fail evidence
model: no model reasoning strictly required for command execution; a lightweight model may summarize logs, but must not alter pass/fail results
read_only: true with respect to the PR's source branch — only runs configured commands in an isolated worktree/sandbox and posts a marker
---

# Verifier

## Purpose

Prove that the PR's **current head SHA** is safe to hand to a human
reviewer by running the repo's configured install/test/build commands,
redacting sensitive output, secret-scanning the diff, and recording a
single verification marker bound to that exact SHA.

## Model / persona expectations

This phase is primarily mechanical: run configured commands, capture
results. Any model use is limited to summarizing/redacting logs for the
runlog — it must never be able to override a failing command's exit code
or fabricate a passing result.

## Allowed inputs

- The PR's current head SHA and diff (this is PR-controlled, i.e.
  effectively untrusted code, since it originates from an automation
  branch that could in principle contain adversarial content).
- `test-plan.md` from the spec, to know what UI/UX evidence is required.
- `verification` config: `sandboxCommand`, `allowHostExecution`, reviewer
  list.

## Untrusted-data handling

The code under test is treated as untrusted/PR-controlled: it must never be
executed directly on the maintainer's host unless `allowHostExecution` has
been explicitly set to `true` in config, accepting that risk. Log output is
redacted for secrets/tokens/PII before being posted or persisted.

## Allowed side effects

- Run configured install/test/build commands **only** inside an isolated
  worktree and, preferably, the configured `sandboxCommand` (e.g. a
  network-disabled container).
- Update a single verification marker/comment on the PR, keyed to the
  current head SHA (replacing, not duplicating, prior markers for stale
  SHAs).
- Attach or require before/after screenshots when UI files changed.
- No merges, no marking ready, no code edits.

## Required durable outputs

- One verification marker per head SHA, with pass/fail per configured
  check and links/paths to redacted logs.
- Screenshots (or an explicit blocker noting they are missing) for UI
  changes, stored under the issue's spec folder (e.g. `screenshots/`).
- A runlog entry summarizing the verification result.

## Artifact type / prefix

`VER` — verification marker/comment plus any redacted log artifacts under
`docs/automation/specs/issue-<number>-<slug>/`.

## Required summary format

```
phase: verifier
issue: #<number>
artifact: VER-<number>-<slug> (PR #<pr-number> @ <headSha>)
status: pass|fail|refused
decision: proceed|block
sha: headSha=<sha>
notes: <one line — which check failed, or "all checks passed"; screenshot status if UI changed>
```

## Gate / decision output

- `pass` → eligible for finalizer.
- `fail` → PR stays draft with a blocker describing the failing check.
- `refused` → no sandbox configured and `allowHostExecution` is not
  explicitly `true`; verification **fails closed** rather than running
  unsandboxed or being silently skipped.

## Security notes

- Fail closed by default: absent an explicit `sandboxCommand` or an
  explicit `allowHostExecution=true` opt-in, refuse to run install/test/build
  scripts from PR-controlled code on the maintainer's host.
- Always redact secrets/tokens/PII from logs before they are posted or
  persisted anywhere.
- Secret-scan the diff itself, independent of the redaction applied to
  command output.
- Never let this phase mark the PR ready or merge it, regardless of
  verification outcome — that is the finalizer's and human's job
  respectively.
- Re-run and re-bind on every new head SHA; a marker for an old SHA must
  never be treated as valid for a newer one.
