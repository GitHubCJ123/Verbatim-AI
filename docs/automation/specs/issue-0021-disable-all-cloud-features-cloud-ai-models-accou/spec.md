# Spec — Issue #21: Disable all cloud features (local-only) behind one flag

**Issue:** https://github.com/GitHubCJ123/Verbatim-AI/issues/21
**Implementation PR:** https://github.com/GitHubCJ123/Verbatim-AI/pull/24
**Status:** Approved (spec + adversarial review approved via dashboard 2026-07-08).

## Goal

Ship Verbatim AI as a **fully local-only** app by disabling every
cloud-dependent surface behind a single build-time flag
`CLOUD_FEATURES_ENABLED` (in a new `src/lib/features.ts`, initial value
`false`). **No cloud code is deleted** — re-enabling later (behind a future
subscription) is a one-line flag flip.

Cloud surfaces in scope:
1. Cloud AI models — Azure Whisper (transcription) + Azure GPT (cleanup),
   proxied through Supabase Edge Functions (`SupabaseAIProvider`).
2. Cloud account/sync app mode — first-launch "Create account", Modes /
   vocabulary / history sync.
3. Supabase sign-in / sync — auth gate, Account page, migration flow.

## Design: gate at the data/resolution layer (non-destructive)

Values already persisted in `localStorage` or per-Mode overrides that still
hold `"cloud"` resolve to a local engine **at read time**; the stored value
is preserved so a re-enable is clean.

- `features.ts` — master flag (typed `boolean` so gated branches stay live).
- `appMode.ts` — `getAppMode()` returns `"local"` when off; raw
  `getStoredAppMode()` retained for a future re-enable.
- `ai/localWhisper.ts`, `ai/ollama.ts` — provider-kind getters coerce
  `cloud → local`; setters no-op on `cloud` when off; shared
  `effectiveTranscribeKind` / `effectiveCleanupKind` helpers.
- `ai/index.ts` — provider resolution uses the effective kinds; the
  transcribe-only providers' cleanup fallback is non-cloud when off.
- `privacyStatus.ts` — reuses the same effective helpers so the indicator
  always reports on-device and can't drift from the real pipeline.

UI affordances hidden when off: Settings & Onboarding cloud engine options,
ModeEditor cloud per-Mode overrides, ModePicker "Create account" card,
Sidebar Account nav, `settingsRegistry` `page-account` entry; App router
redirects `/auth`, `/migrate`, `/account` to `/`.

## Acceptance criteria

- Fresh install boots straight into local-only: no cloud AI options, no
  account/sign-in prompts, no ModePicker "Create account" card.
- Settings → AI model shows only local engines (Whisper/Parakeet ·
  Ollama/llama.cpp/None).
- Onboarding never offers/selects cloud; quick-start yields a local setup.
- No route reaches AuthGate, Account, or MigrationPicker while disabled.
- Privacy indicator always reports on-device.
- All cloud code remains; re-enable is a single flag flip.
- `pnpm build`, `cargo check`, and existing tests pass.

## Out of scope

Subscription/entitlement system and the actual re-enable; removing Supabase
Edge Functions or backend infra.
