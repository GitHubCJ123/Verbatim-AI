<!-- verbatim-ai:artifact:v1 issue=21 phase=agent-pr-review id=issue-0021-reconcile-pr24-REVIEW-001 display=REVIEW-001 run=reconcile-pr24 -->
# REVIEW-001: Agent PR review of PR #24

- Issue: #21
- Phase: agent-pr-review
- Prefix: REVIEW
- Artifact ID: issue-0021-reconcile-pr24-REVIEW-001
- Agent: code-review agent
- Run: reconcile-pr24
- Created: 2026-07-08T06:01:28.565Z

## Summary

APPROVE-WITH-NITS; one Low finding (unconditional useAuth.init in main.tsx) fixed by gating on the flag (commit 86a11a3). No blocking findings remain.

## Body

Agent PR review of PR #24 (issue #21 — disable cloud features behind
CLOUD_FEATURES_ENABLED). Reviewer: code-review agent. Verdict:
APPROVE-WITH-NITS → resolved to clean after one developer iteration.

## Assessment (all focus areas passed)

1. Cloud provider paths unreachable, including stale per-Mode "cloud"
   overrides: transcribeProvider/cleanupProvider wrap the resolved kind in
   effectiveTranscribeKind/effectiveCleanupKind; getCloud() has no reachable
   caller when off (cloudCleanupFallback returns the local cleanup provider).
2. Non-destructive / clean re-enable: getStoredAppMode preserves the raw
   value; setters no-op on "cloud"; the onboarding AIStep auto-fix effect no
   longer fires when off, so nothing overwrites a stored "cloud".
3. Privacy indicator uses the identical effective*Kind(override ?? getter)
   expression as provider resolution, so it cannot report "local" while cloud
   runs.
4. Router/boot: /auth, /migrate, /account redirect to / when off; the boot
   cloud branch is dead; no broken links.
5. React correctness: every gated Select value derives from a coerced getter
   or is coerced inline, so it always matches a rendered SelectItem; the
   Onboarding filter().map() refactor keeps keys and balanced JSX.

## Finding (Low) and resolution

- main.tsx called `useAuth.getState().init()` unconditionally, NOT behind the
  flag. With Supabase creds shipped in a build AND a prior session in
  localStorage, init() would restore and background-refresh that account
  session even with cloud "disabled" — and getAppMode()==="local" plus the
  Account redirect leaves no in-app sign-out. No dictation content is exposed
  (that path is fully gated); no-op when Supabase is unconfigured.
- RESOLUTION (developer iteration): gated the init() call on
  `CLOUD_FEATURES_ENABLED` in main.tsx (commit 86a11a3). The local-only flag
  flip is now airtight. Re-verified: tsc clean, 36 tests pass, build succeeds,
  prettier clean.

Decision: approve — no blocking findings remain after the fix.

