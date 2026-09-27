# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                 # install JS dependencies
pnpm tauri dev               # run the full desktop app in dev mode (starts Vite + Rust)
pnpm dev                     # Vite dev server only (no Tauri shell — useful for pure UI work)
pnpm build                   # tsc + vite build (frontend only)
pnpm tauri build             # production installer (MSI + NSIS + macOS DMG)
pnpm lint                    # ESLint
pnpm format                  # Prettier
```

First run: copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.

First `cargo` build takes several minutes; subsequent builds are incremental.

### Automation publication and test preset

Historical transcripts in `docs/automation/specs/` use `[REDACTED_REPOSITORY]`
and `[REDACTED_SESSION]` in place of private host paths. These are publication
redactions, not executable paths. Unrelated personal session history is also
explicitly marked as redacted; other historical output is preserved.
Artifact SHA-256 references describe the published Markdown bytes, including
redactions, in both `summary.json` artifact collections and `runlog.jsonl`.

`.copilot/issue-loop/config.test53.json` is an explicit live-test preset, not
the default config. Selecting it with `--config` enables GitHub/git writes and
host verification (`enabled: true`, `dryRun: false`, `allowHostExecution: true`).
It selects issues carrying **both** `automate` and `automation-test`; its name
does not restrict it to issue #53. Use it only for trusted, maintainer-enrolled
test issues on a disposable, least-privilege host. A worktree and command
denylist are not a security sandbox. Publishing the preset does not activate it.

### Supabase

```bash
supabase db push                                  # apply schema migrations
supabase functions deploy transcribe --no-verify-jwt
supabase functions deploy cleanup --no-verify-jwt
```

## Architecture

Verbatim AI is a **Tauri 2** desktop app: a Rust backend (`src-tauri/`) combined with a React/TypeScript frontend (`src/`). The app runs **two separate Tauri windows**:

- **`main`** — the settings/management UI (React Router, `src/App.tsx`).
- **`overlay`** — a transparent, always-on-top floating pill/panel (`overlay.html`, `src/overlay/`). Rendered from a separate HTML entrypoint configured in `vite.config.ts` and `tauri.conf.json`.

### Recording pipeline (hotkey press → pasted text)

1. Rust emits `hotkey:down` / `hotkey:up` via `tauri_plugin_global_shortcut`.
2. `src/lib/hotkey.ts` catches the events and calls `src/lib/modeResolver.ts` to look up the foreground app (`get_active_window` Tauri command) and resolve which Mode to use.
3. `src/lib/recording-bridge.ts` shows the overlay and emits `recording:start { modeName, modeId }` to the overlay window.
4. **Inside the overlay** (`src/overlay/Overlay.tsx`): `src/lib/audio.ts` captures mic audio using the Web Audio API. On stop, audio is sent to the active AI provider.
5. `src/lib/ai/index.ts` (`getActiveProvider`) picks a composite provider (transcription and cleanup can come from different backends).
6. After cleanup, text is pasted via the `paste_to_target` Tauri command (Rust side: `src-tauri/src/commands/paste.rs`).

### AI providers

Defined in `src/lib/ai/AIProvider.ts`. Three implementations:

- **`SupabaseAIProvider`** (`src/lib/ai/index.ts`) — calls Supabase Edge Functions that proxy Azure AI Foundry. Used in both local and cloud app modes.
- **`LocalWhisperProvider`** (`src/lib/ai/localWhisper.ts`) — shells out to a downloaded `whisper-cli` sidecar binary.
- **`ParakeetProvider`** (`src/lib/ai/parakeet.ts`) — shells out to a `sherpa-onnx` sidecar binary.
- **`OllamaProvider`** (`src/lib/ai/ollama.ts`) — local Ollama for the cleanup (LLM) step only.

`getActiveProvider(mode?)` returns a composite that picks transcribe and cleanup halves independently based on global settings and per-Mode overrides.

### App modes: local vs cloud

`src/lib/appMode.ts` — `localStorage` key `sw.app.mode` is either `"local"` or `"cloud"`.

- **Local**: no Supabase auth. Modes/vocab live in `localStorage` only. Edge Functions are still called with the anon key (deployed `--no-verify-jwt`).
- **Cloud**: Supabase auth; Modes/vocab are synced from Postgres.

### State management

All data stores use **Zustand** (`src/lib/store/`). Every store that mutates also writes a `localStorage` cache (keys prefixed `sw.`) so the overlay window can read synchronously without network calls. The main window calls `hydrateAll()` on boot to populate from Supabase (cloud mode) or seed built-ins (local mode).

Key stores: `useAuth`, `useModes` + `useVocabulary` (same file), `useAppMappings`, `useProfile`, `useRecording`, `useOnboarding`.

### Mode resolution

`src/lib/modeResolver.ts` — at hotkey press, reads `app_mappings` and `modes` from `localStorage` and matches by `appExecutable` (case-insensitive). If a mapping has `matchWindowTitle`, it's treated as a regex against the foreground window title. Falls back to the default Mode.

### Styling

CSS custom properties defined in `src/styles/tokens.css` (dark + light variants). All colors/radii/shadows must use these variables. Tailwind is configured in `tailwind.config.js` to map them via `var(--token-name)`.

### Rust commands (`src-tauri/src/commands/`)

| File | Purpose |
|------|---------|
| `active_window.rs` | Get foreground window exe + title (platform-specific) |
| `hotkey.rs` | Register/clear global shortcuts |
| `paste.rs` | Capture target window before overlay shows; simulate paste |
| `local_whisper.rs` | Download/manage whisper-cli sidecar; invoke transcription |
| `parakeet.rs` | Download/manage sherpa-onnx sidecar; invoke transcription |
| `relay.rs` | Forward Tauri events between windows |
| `process_list.rs` | List running apps for app-mapping UI |
