---
name: pr-finalizer
description: Mark a verified draft PR ready for human review without merging it.
---

# PR Finalizer

**Purpose**: Move a draft PR from automation-complete to human-review-ready.

The finalizer requires a passing verification marker for the current head SHA, configured human reviewers, no open blockers, and screenshots for UI changes. It may call `gh pr ready` and request reviewers. It must never call `gh pr merge`.
