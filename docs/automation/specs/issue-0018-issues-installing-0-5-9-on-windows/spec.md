# Spec: issue #18 Windows install Local Whisper defaults/runtime errors

## Problem

The no-account setup path currently defaults transcription to Azure, which surprises users choosing local mode. When the user later selects Local Whisper on Windows, runtime installation can fail with a raw GitHub 404 for `whisper-runtimes.json` if the app version's release is still draft/unpublished or runtime assets are not public.

## Non-goals

- Do not change cloud/account setup defaults.
- Do not publish GitHub releases from app code.
- Do not remove cloud AI as an explicit user-selectable option.
- Do not bypass signed runtime manifest verification.

## Current repo facts

- `ModePicker` sets only `sw.app.mode`; it does not initialize AI provider defaults.
- `applyQuickDefaults()` in onboarding unconditionally sets transcription and cleanup to cloud.
- `AIStep` initializes from `getAiProviderKind()`, whose fallback is cloud.
- `verified_runtime_manifest()` downloads `whisper-runtimes.json` and `.sig` from `releases/download/v{CARGO_PKG_VERSION}` and surfaces raw `reqwest` errors.
- Release `v0.5.9` currently has Whisper runtime assets but is draft, so public app requests receive 404.

## Architecture

1. When the user chooses "Use locally", initialize AI defaults to:
   - transcription: `local-whisper`
   - cleanup: disabled/raw transcript
   - persisted cleanup provider: local backend, not cloud
2. During onboarding in local mode, guard against legacy/default cloud fallback by switching the AI step to Local Whisper and cleanup none.
3. Quick-start defaults should follow app mode:
   - local app mode: Local Whisper + cleanup off
   - cloud app mode: Cloud transcription + Cloud cleanup
4. Runtime download errors should explain release-asset availability instead of raw HTTP status.

## Security and privacy

- Local mode should not silently send audio to Azure by default.
- Local mode should not persist cloud cleanup behind the disabled cleanup flag.
- Runtime downloads must continue using the signed manifest and checksum verification.
- Error messages must not include secrets or local paths.

## Implementation waves

1. Update first-launch/local onboarding defaults.
2. Add release-asset-specific runtime download errors for manifest, signature, and archive 404s.
3. Add tests for troubleshooting/error text where feasible.
4. Validate build, tests, Rust check, and UX evidence.

## Acceptance criteria

- Selecting "Use locally" starts with Local Whisper as the transcription provider.
- Quick-start in local mode does not set cloud transcription.
- Cloud/account setup still defaults to cloud.
- Local Whisper 404s explain that release runtime assets are not publicly available yet and suggest publishing the release or installing a version with published assets.
- Existing signed manifest verification remains intact.

## Verification

- `corepack pnpm test`
- `corepack pnpm build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

## UX evidence

See `ux-evidence.md`.
