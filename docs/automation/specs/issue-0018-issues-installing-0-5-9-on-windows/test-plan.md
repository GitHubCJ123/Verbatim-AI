# Test plan

- Verify local ModePicker initializes `local-whisper` and disables cleanup when "Use locally" is chosen.
- Verify local-mode quick-start sets Local Whisper and cleanup off.
- Verify cloud/account quick-start still sets cloud transcription and cleanup.
- Verify Local Whisper runtime 404 errors mention unpublished/unavailable release assets.
- Run:
  - `corepack pnpm test`
  - `corepack pnpm build`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - `git diff --check`
