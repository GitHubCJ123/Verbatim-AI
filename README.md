# Verbatim AI

A Windows desktop voice-transcription app with a modern, animated UI.

> Talk anywhere. We type it for you, in your voice, in the right tone, in any app.

Hold a global hotkey, speak, release — Verbatim AI transcribes your audio, polishes it with the tone of the app you're in, and pastes the result wherever your cursor is.

See [`plan.md`](./plan.md) for the full product, architecture, and roadmap.

## Features

- **Global push-to-talk hotkey** — default `Ctrl+Space`, fully rebindable.
- **Per-app tone** — Slack stays casual, Gmail stays formal, code comments stay terse. Driven by user-defined Modes + app mappings.
- **Custom vocabulary** — keep proper nouns and jargon spelled correctly.
- **Translation** — speak any language, output in another.
- **Cloud-backed** — Supabase Postgres for sync, Supabase Edge Functions proxying Azure AI Foundry for transcription + polish. No keys on the client.
- **Tray-resident** — close the window, app keeps running. Autostart optional.
- **Dark + light themes**, follows OS by default.
- **Onboarding** generates Modes + app mappings from a few tone picks.

## Install

Grab the latest installer from [Releases](../../releases) and run either:

- `Verbatim AI_x.y.z_x64-setup.exe` (NSIS — recommended, per-user, no admin)
- `Verbatim AI_x.y.z_x64_en-US.msi` (MSI — for managed deployment)

> Windows SmartScreen will warn on first launch because the binaries are not yet code-signed. Click **More info → Run anyway**.

## Prerequisites (developers)

- **Node.js 20+** and **pnpm 9+**
- **Rust** stable — install via [rustup](https://rustup.rs)
- **MSVC Build Tools** — "Desktop development with C++" workload from [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **WebView2 Runtime** (ships with modern Windows)

## Dev

```powershell
pnpm install
Copy-Item .env.example .env.local   # fill in Supabase URL + anon key
pnpm tauri dev
```

The first `cargo` build takes several minutes; subsequent builds are incremental.

### Environment

Verbatim AI is online-only. Set these in `.env.local`:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY
```

Azure credentials live in **Supabase secrets**, not on the client. See [`supabase/functions/README.md`](./supabase/functions/README.md).

### Database

Apply migrations against your Supabase project:

```powershell
supabase db push
```

### Edge Functions

```powershell
supabase functions deploy transcribe --no-verify-jwt
supabase functions deploy cleanup --no-verify-jwt
```

## Build a release installer

```powershell
pnpm tauri build
```

Outputs to `src-tauri/target/release/bundle/`:

- `nsis/Verbatim AI_x.y.z_x64-setup.exe`
- `msi/Verbatim AI_x.y.z_x64_en-US.msi`

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Vite dev server (frontend only) |
| `pnpm tauri dev` | Run desktop app in dev mode |
| `pnpm tauri build` | Build production installers (MSI + NSIS) |
| `pnpm lint` | Run ESLint |
| `pnpm format` | Run Prettier |

## License

TBD.
