# Issue loop agent definitions

This directory holds one reviewable Markdown definition per phase of the local
Copilot issue loop (`.copilot/issue-loop/issue-loop.mjs`). Each file is meant
to be read top-to-bottom by a maintainer before the phase is trusted with
real credentials, and each follows the same template so diffs between
phases are easy to compare.

## Phases (execution order)

| # | File | Phase | Artifact prefix |
|---|------|-------|------------------|
| 01 | `01-issue-monitor.md` | Issue monitor | none (claim marker only) |
| 02 | `02-requirements-critic.md` | Requirements critic | `PRD` |
| 03 | `03-architect-spec.md` | Architect spec | `SPEC` |
| 04 | `04-adversarial-reviewer.md` | Adversarial reviewer | `ADV` |
| 05 | `05-implementer.md` | Implementer | `IMPL` |
| 06 | `06-agent-pr-reviewer.md` | Agent PR reviewer | `REVIEW` |
| 07 | `07-verifier.md` | Verifier | `VER` |
| 08 | `08-finalizer.md` | Finalizer | `FINAL` |
| 09 | `09-human-pr-review.md` | Human PR review | `HUMAN` |
| 10 | `10-self-reflector.md` | Self-reflector | `REFLECT` |
| 11 | `11-cleanup.md` | Cleanup | `CLEAN` |

## Shared conventions encoded in every definition

- **Trigger stays manual.** Nothing here runs on every issue automatically;
  eligibility is gated by an allowlist label (default `automate`) and/or
  explicit config, plus the `.copilot-issue-loop/STOP` kill switch.
- **Read-only by default.** The architect, adversarial reviewer, and agent
  PR reviewer only read repository/PR state and write to their own
  controlled artifact paths unless a definition explicitly states a wider
  side effect.
- **Implementer is isolated.** Work happens in a dedicated git worktree on a
  deterministic branch; the only GitHub side effect is opening a **draft**
  PR. It never merges and never force-pushes.
- **Verifier binds to the current PR head SHA** and fails closed: if no
  sandbox command is configured and host execution has not been explicitly
  opted into (`verification.allowHostExecution=true`), verification is
  refused rather than silently skipped or run unsandboxed.
- **Finalizer can only mark the PR ready and request reviewers.** It never
  calls `gh pr merge`.
- **Cleanup only runs after a confirmed-merged PR** (checked authoritatively
  via `gh`, not inferred locally) and applies containment checks before
  deleting any worktree or branch.
- **Every phase emits a concise structured summary** intended to be
  appended to a durable runlog / knowledge-graph-style record so the loop's
  history stays reconstructable without re-reading full transcripts.
- **Untrusted content is always issue/PR/comment/feedback text.** It is
  treated as data to parse or summarize, never as instructions, and is
  never used to justify expanding a phase's declared side effects.

Each definition below uses the same section order: Purpose, Model/persona
expectations, Allowed inputs, Untrusted-data handling, Allowed side
effects, Required durable outputs, Artifact type/prefix, Required summary
format, Gate/decision output, Security notes.
