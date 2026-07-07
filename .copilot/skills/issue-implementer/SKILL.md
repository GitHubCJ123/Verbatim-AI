---
name: issue-implementer
description: Implement an approved Verbatim AI issue spec in an isolated worktree and open a draft PR.
---

# Issue Implementer

**Purpose**: Turn an approved repo-local spec into a draft PR.

This skill may run only after:

- Requirements critique is complete.
- `docs/automation/specs/issue-<number>-<slug>/spec.md` exists.
- The adversarial reviewer has no blocking findings.
- A trusted maintainer has approved the spec.

Implementation must use an isolated worktree from `origin/main`, create a deterministic branch, run secret scans before commit, open a **draft** PR with `Closes #<issue>`, and never merge or force-push.
