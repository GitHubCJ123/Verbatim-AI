# Verbatim AI

A Windows and macOS desktop voice-transcription app with a modern, animated UI.

> Talk anywhere. We type it for you, in your voice, in the right tone, in any app.

Hold a global hotkey, speak, release — or disable push-to-talk to press once to
start and again to finish. Bare Fn and right Command shortcuts remain hold-only.
Verbatim AI transcribes your audio, optionally polishes it with the tone of the
app you're in, and pastes the result wherever your cursor is.

See [`plan.md`](./plan.md) for the full product, architecture, and roadmap.

Coding agents should start with the canonical [`AGENTS.md`](./AGENTS.md) contract
for current implementation boundaries, applicable checks and privacy/release gates.

## Features

- **Global dictation hotkey** — default `Ctrl+Space` on Windows and
  `Control+Shift+Space` on macOS, rebindable with hold or toggle behavior. Windows reports registered shortcuts already in use: choose another shortcut, since another app's binding cannot be overridden. macOS only shows best-effort warnings for common Spotlight, Finder search and Force Quit shortcuts; arbitrary cross-app conflicts cannot be reliably detected. Failed replacements keep the prior active binding, and rejected choices are not saved. Recording a shortcut temporarily releases the active binding; if another app claims it during capture and restoration fails, the error is reported explicitly. macOS fn/right-command presets may be saved as **pending Input Monitoring permission**, not reported as active.
- **Per-app tone** — Slack stays casual, Gmail stays formal, code comments stay terse. Driven by user-defined Modes + app mappings.
- **Writing Style** — choose your default from existing Modes, including custom recipes.
  Expand **Advanced: Mode recipes** to create, duplicate, reorder or edit them.
  **Customize** opens the selected recipe; its prompt, language, output, hotkey
  and AI overrides live under **Advanced recipe settings** and still use **Save changes**.
  App mappings continue to take priority over the default style.
  Find app mappings under **Writing Style → Apps**.
- **Custom vocabulary** — keep proper nouns and jargon spelled correctly. In Review, select a corrected term and choose **Add corrected term**, edit the suggested spelling, then **Save term**. With no selection, enter the term yourself. Cancel saves nothing; terms are never learned automatically. Manage them in Vocabulary. Only the confirmed term is stored (locally while cloud features are disabled), not the surrounding dictation. Empty, multi-line, over-200-character and duplicate terms are rejected; save failures leave the draft available to retry.
- **Translation** — speak any language, output in another.
- **Local processing** — speech transcription and optional AI polish run on-device.
  Cloud providers, accounts and sync are currently disabled. Model downloads and
  app updates use the network; downloaded models can run offline.
- **Tray-resident** — close the window, app keeps running. Autostart optional.
- **Dark + light themes**, follows OS by default.
- **Onboarding** generates Modes + app mappings from a few tone picks.

### Dictation delivery and recovery

The completion feedback reports **Pasted** only when the native paste command
confirms that input was dispatched to the captured app. **Copied** means the text
reached the clipboard instead. This does not verify that the destination app
accepted or retained the input.

If paste, capture, final transcription, polish, or history saving fails after text
is available, Review keeps that text for Copy, Paste, or Discard. Recovered live
previews are explicitly marked incomplete. Review waits for an explicit action;
it is not itself a successful paste. Finish Review before recording again.
Blank/noise transcripts and accidental short taps are intentionally suppressed.

On macOS, a missing typing permission opens guided recovery with **Open Settings**.
The permission is under **Privacy & Security → Device Control and Data Access**
(**Accessibility** on older macOS versions). The button requests permission and
opens the native permission pane; Verbatim AI never enables access for you.
Enable Verbatim AI there, or use **+** to add the app if missing. If access is
already enabled after an update, fully quit and reopen the app. **Copy unsaved
Review text before quitting.** If Settings cannot open, manual instructions stay
visible. The same guidance is available from History and onboarding.

History is saved only when both global history and the active Mode permit it,
using the existing storage and retention rules. With history off, recovery text
exists only in the open Review window: copy it before closing or quitting.
There is no hidden transcript journal or persisted audio recovery. Storage or
cross-window acknowledgement failures keep Review open and warn when a paste
already happened, rather than silently claiming the result was saved.

### Local diagnostics

Settings → Privacy offers a separate, **off-by-default** local diagnostics
journal. If enabled, it records timestamps, the app version, fixed failure
categories and the current processing stage even when transcript history is
off. After an unclean exit, the last stage may appear in the report. An unclean
exit may be a crash, forced quit or interrupted shutdown, and its stage is
best-effort. The report includes the operating system and CPU architecture, but
no transcript, audio, prompts, clipboard contents, app/window names or raw error
messages. The journal is stored unencrypted on this device; nothing is uploaded
automatically.

The journal keeps at most 100 events. Events expire after seven days and are
removed on access, hourly while the app runs, or on the next launch if the app
was closed. You can inspect and explicitly copy the report, or delete it and
turn diagnostics off in Settings. Deletion or storage failures are reported.
This journal does **not** recover dictation and does not change global or Mode
transcript-history settings.

## Install

Grab the latest installer from [Releases](../../releases) and run either:

- `Verbatim AI_x.y.z_x64-setup.exe` (NSIS — recommended, per-user, no admin)
- `Verbatim AI_x.y.z_x64_en-US.msi` (MSI — for managed deployment)

> Windows SmartScreen will warn on first launch because the binaries are not yet code-signed. Click **More info → Run anyway**.

### macOS

- `Verbatim AI_x.y.z_aarch64.dmg` (Apple Silicon)

Verbatim AI for macOS is **not yet notarized**, so macOS quarantines it on download. Because of that quarantine, macOS runs the app from a temporary read-only copy (**App Translocation**), which stops the built-in auto-updater from replacing the app in `/Applications` — an update appears to download but `/Applications` stays on the old version.

To install (and to let auto-updates work):

1. Drag **Verbatim AI** into your **Applications** folder.
2. Remove the quarantine flag so macOS stops translocating it:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Verbatim AI.app"
   ```

3. Launch it from Applications.

After that, in-app updates install correctly. If you skip step 2, the app detects the situation and shows a **Download update** prompt (in the banner and in **Settings → App updates**) instead of silently updating a throwaway copy.

## Prerequisites (developers)

- **Node.js 20+** and **pnpm 9+**
- **Rust** stable — install via [rustup](https://rustup.rs)
- **MSVC Build Tools** — "Desktop development with C++" workload from [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **WebView2 Runtime** (ships with modern Windows)

## Dev

```powershell
pnpm install
pnpm tauri dev
```

The first `cargo` build takes several minutes; subsequent builds are incremental.

### Environment

No Supabase configuration or account is required for the current local-only app.
Choose and download a speech model in Quick Start or Settings before dictating;
AI polish can be turned off or use a downloaded local model.

The following configuration and backend commands are for maintainers of the
disabled cloud integration, not local setup steps. Do not re-enable cloud
features or deploy a backend just to run the app. If working on that integration,
keep environment values in ignored `.env.local`:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY
# Optional, only if VERBATIM_EDGE_APP_SECRET is set on Edge Functions:
VITE_VERBATIM_EDGE_APP_SECRET=YOUR-ROLLOUT-SECRET
```

Azure credentials live in **Supabase secrets**, not on the client. See [`supabase/functions/README.md`](./supabase/functions/README.md).

### Database (disabled cloud integration)

Apply migrations against your Supabase project:

```powershell
supabase db push
```

### Edge Functions (disabled cloud integration)

```powershell
supabase functions deploy transcribe
supabase functions deploy cleanup
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
| `pnpm automation:issues -- --once --config .copilot/issue-loop/config.local.json` | Run one local issue automation tick |
| `pnpm automation:issues -- --watch --config .copilot/issue-loop/config.local.json` | Poll opted-in issues continuously on a maintainer machine |
| `pnpm automation:dashboard` | Start the local issue automation dashboard |
| `pnpm automation:test` | Run tests for the local issue automation loop |

## Local issue automation

This repo includes a local, human-gated Copilot issue loop under `.copilot/issue-loop/`. It is disabled and dry-run by default, uses your local `gh` and Copilot CLI auth, and never merges PRs.

To trigger it:

1. Copy `.copilot/issue-loop/config.example.json` to `.copilot/issue-loop/config.local.json`.
2. Set `enabled: true`, keep `dryRun: true`, and configure at least one reviewer.
3. Add the `automate` label to an issue.
4. Run `pnpm automation:issues -- --once --config .copilot/issue-loop/config.local.json`.
5. If the dry run is correct, set `dryRun: false` and run the same command, or use `--watch` for continuous polling.

The loop first critiques requirements and creates a repo-tracked spec in `docs/automation/specs/`. Clear requirements and clear spec review can move forward automatically; human input is requested only when review raises open questions. Any PR it opens starts as a draft, must pass agent PR review, verification, and screenshot requirements, and still requires human review/merge.

For a visual workflow, run `pnpm automation:dashboard` and open the printed localhost URL. The dashboard shows real open issues, requirements critique status, phase approvals, feedback, and self-reflection without writing to GitHub by default. There is no demo issue; use a real issue and the `automate` label when you want implementation to become eligible.

## License

TBD.
