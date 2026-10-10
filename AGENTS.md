# Verbatim AI agent contract

This is the canonical repository guidance for all coding agents, including work
started in subdirectories. Work in the assigned checkout; verify the remote is
`GitHubCJ123/Verbatim-AI` before publishing. Do not modify another checkout.

## Current architecture and boundaries

- React/TypeScript, Zustand and Tailwind live in [`src/`](src/). The main and
  overlay WebViews use Tauri IPC; coordinate command, event and payload changes
  with [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) and the Rust handlers.
- [`src-tauri/src/commands/`](src-tauri/src/commands/) owns native microphone
  capture, global hotkeys, permissions, target-window paste, model/runtime
  installation and sidecar lifecycles. Preserve Windows and macOS behavior and
  platform guards; frontend mocks do not prove OS integration.
- Provider interfaces and independent transcription/cleanup routing live in
  [`src/lib/ai/`](src/lib/ai/). Reuse the existing providers and IPC wrappers.
  [`sidecars/whisper-stream/`](sidecars/whisper-stream/) is native C++ code,
  not a frontend module.
- **Cloud features are currently disabled** by
  [`src/lib/features.ts`](src/lib/features.ts). Preserve this gate across
  providers, account/sync and UI, including non-destructive resolution of old
  stored cloud selections. The README's online-only description is historical;
  [`plan.md`](plan.md) and proposal/testing documents are not proof that a
  feature or test runner has shipped. Check current code and configuration.

## Applicable checks

Use commands from [`package.json`](package.json) and the current
[`PR workflow`](.github/workflows/pr-checks.yml), selecting checks for the change:

- Frontend logic/UI: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`.
  Target individual tests with `pnpm test -- <path>`.
- Frontend production compilation: `pnpm build` (TypeScript + Vite, not an installer).
- Rust/native changes: `cargo test --manifest-path src-tauri/Cargo.toml`.
  The PR workflow runs this on macOS; report platform-specific coverage honestly.
- Local issue-loop changes: `pnpm automation:test`; preserve its human gates.
- Documentation-only changes: check local links, factual commands and
  `git diff --check`; no app launch or engine invocation is needed.

[`vitest.config.ts`](vitest.config.ts) excludes real-engine tests. In contrast,
`pnpm test:engines` uses [`vitest.engines.config.ts`](vitest.engines.config.ts)
and can contact real Ollama/Supabase backends, transmit fixtures and consume
quota. Do not treat availability-based skips as engine coverage. Use synthetic
fixtures and mocked IPC for ordinary validation; obtain explicit authorization
before real recordings, account access or paid/cloud engine runs. The
[`testing strategy`](docs/testing/automated-testing-strategy.md) also contains
planned runners/backdoors: do not invent commands from it.

## Privacy, credentials and release gates

- Audio, raw/cleaned transcripts, clipboard contents and app/window metadata
  can be private. Do not put real user data in fixtures, logs, screenshots,
  commits or PRs; use synthetic data. Preserve history retention and local/cloud
  storage boundaries in [`src/lib/history.ts`](src/lib/history.ts).
- Keep local environment/auth state ignored. Azure and service-role credentials
  belong server-side, never in `VITE_*` values or client bundles. Follow the
  [`Edge Function contract`](supabase/functions/README.md): preserve JWT/auth,
  quota and size checks. The optional bundled app secret is defense-in-depth,
  not an authentication or quota boundary.
- Preserve runtime checksum/signature verification and updater environment
  guards. Signing private keys stay in the existing secret store, never in
  repository files or output.
- `pnpm tauri dev` launches the app; `pnpm tauri build` builds installers.
  Neither is required for documentation work. Tag pushes matching `v*` and
  manual dispatch enter the [`release workflow`](.github/workflows/release.yml),
  which signs/uploads assets and publishes releases. Require explicit release
  authorization; do not tag, dispatch, deploy Supabase or publish as validation.
- The [local issue loop](.copilot/issue-loop/README.md) is opt-in, disabled and
  dry-run by default, opens draft PRs and **never merges**. Do not enable it,
  broaden eligibility or bypass human review as a side effect of another task.
  Leave merging to humans and distinguish verified changes, pushed branches,
  open PRs, merged instructions and locally active instructions in handoffs.
