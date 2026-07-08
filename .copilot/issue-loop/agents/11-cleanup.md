---
phase: cleanup
order: 11
artifact_prefix: CLEAN
trigger: manual (runs only after human-pr-review observes a confirmed-merged PR)
persona: janitor — mechanical, containment-checked deletion only
model: no reasoning model required; deterministic checks against naming/path patterns
read_only: false — but strictly scoped to deleting the specific automation worktree/branch it created, after containment checks pass
---

# Cleanup

## Purpose

Remove the isolated git worktree and branch created by the implementer
phase once — and only once — the corresponding PR is confirmed merged,
without ever touching a worktree or branch that doesn't unambiguously
belong to this loop's own automation.

## Model / persona expectations

No reasoning is required beyond deterministic checks: confirm merge status
authoritatively via `gh`, confirm the worktree path and branch name match
the loop's own deterministic naming convention, then delete. This should be
implementable as a plain script step, not a free-form agent.

## Allowed inputs

- The PR's merge status via `gh pr view --json state,mergedAt` (or
  equivalent), treated as the authoritative source of truth — not any local
  guess or cached state.
- The worktree path and branch name recorded by the implementer phase's
  runlog entry.

## Untrusted-data handling

No free-form issue/PR/comment text is consulted for this decision — only
structured `gh` API state (merged/not merged) and the loop's own recorded
worktree/branch identifiers are used, precisely to avoid any untrusted-text
influence over a destructive operation.

## Preconditions (all required)

- `gh` reports the PR's state as merged (authoritative check, not a local
  inference).
- The worktree's absolute path resolves inside the loop's expected
  automation-worktrees root directory.
- The branch name matches the deterministic issue-based naming pattern this
  loop uses (e.g. derived from the issue number/slug), not an arbitrary
  branch.

## Allowed side effects

- `git worktree remove` for the specific worktree created for this issue.
- Delete the local branch, and the remote branch if the loop created it,
  matching the same naming pattern.
- No other git/GitHub side effects: no deleting unrelated branches/worktrees,
  no touching `main`, no repository file changes outside git plumbing for
  this removal.

## Required durable outputs

- A runlog entry recording that cleanup ran, which worktree/branch were
  removed, and the containment checks that passed.

## Artifact type / prefix

`CLEAN` — runlog entry only; no spec-folder file is required, since this is
a terminal housekeeping step.

## Required summary format

```
phase: cleanup
issue: #<number>
artifact: CLEAN-<number>-<slug>
status: cleaned|skipped|blocked
decision: done|hold
sha: mergedSha=<sha>
notes: <one line — worktree/branch removed, or why cleanup was skipped/blocked>
```

## Gate / decision output

- `cleaned` → loop's lifecycle for this issue is complete.
- `skipped` → PR is not (yet) merged; take no destructive action, retry
  later.
- `blocked` → containment check failed (path outside the expected
  automation-worktrees root, or branch name doesn't match the deterministic
  pattern); refuse to delete anything and escalate to the maintainer.

## Security notes

- Always resolve absolute paths before comparison — never rely on
  relative-path string matching, which can be tricked by symlinks or `..`
  segments.
- Verify merge status via the authoritative GitHub API through `gh`, never
  by inferring from local branch state alone (which could be stale or
  spoofed).
- If any containment check fails, fail closed (block, do not delete)
  rather than proceeding with a best-effort guess.
- Never extend this phase's deletion scope beyond the single worktree and
  branch it can prove it created for this specific issue/PR.
