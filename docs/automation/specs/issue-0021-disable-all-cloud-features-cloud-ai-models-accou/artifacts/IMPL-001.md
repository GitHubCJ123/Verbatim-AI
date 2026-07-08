<!-- verbatim-ai:artifact:v1 issue=21 phase=implementation id=issue-0021-reconcile-pr24-IMPL-001 display=IMPL-001 run=reconcile-pr24 -->
# IMPL-001: Implementation adopted from PR #24

- Issue: #21
- Phase: implementation
- Prefix: IMPL
- Artifact ID: issue-0021-reconcile-pr24-IMPL-001
- Agent: developer-agent (adopted PR #24)
- Run: reconcile-pr24
- Created: 2026-07-08T06:01:28.561Z

## Summary

Single-flag CLOUD_FEATURES_ENABLED gating; local-only; PR #24.

## Body

Adopted the developer implementation delivered in PR #24 as the first-party
implementation artifact for issue #21.

- PR: https://github.com/GitHubCJ123/Verbatim-AI/pull/24
- Branch: `copilot/issue21-disable-cloud-features`
- Head: 86a11a3b563e19f9f76beb552b643d1442508c15

Approach: a single build-time flag `CLOUD_FEATURES_ENABLED` (new
`src/lib/features.ts`, value `false`) gates every cloud surface at the
data/resolution layer, non-destructively (read-time coercion; stored values
preserved so re-enable is a one-line flip). No cloud code is deleted.

Files changed (14):
- Core gating: src/lib/features.ts (new), src/lib/appMode.ts,
  src/lib/ai/localWhisper.ts, src/lib/ai/ollama.ts, src/lib/ai/index.ts,
  src/lib/privacyStatus.ts (shared effectiveTranscribeKind /
  effectiveCleanupKind helpers keep the privacy indicator honest).
- UI hidden/redirected: src/routes/Settings.tsx,
  src/routes/onboarding/Onboarding.tsx, src/routes/ModeEditor.tsx,
  src/routes/ModePicker.tsx, src/components/layout/Sidebar.tsx,
  src/lib/settingsRegistry.ts, src/App.tsx.
- Test: src/lib/cloudGating.test.ts (new, 5 tests).

Acceptance criteria from the spec are met: no cloud AI options, no
account/sign-in prompts, no ModePicker "Create account" card; Settings shows
only local engines; onboarding never offers/selects cloud; AuthGate /
Account / MigrationPicker unreachable; privacy indicator always on-device;
all cloud code retained.

