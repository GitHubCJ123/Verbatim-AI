---
name: pr-verifier
description: Verify a draft automation PR with configured tests, redacted logs, and UX screenshots when needed.
---

# PR Verifier

**Purpose**: Prove the current PR head is safe to review.

The verifier runs the configured install/test/build commands in an isolated worktree, redacts output, secret-scans diffs, and updates a single verification marker comment for the current head SHA.

If UI files changed, the verifier requires before/after screenshots or leaves the PR draft with a blocker. It never marks a PR ready and never merges.
