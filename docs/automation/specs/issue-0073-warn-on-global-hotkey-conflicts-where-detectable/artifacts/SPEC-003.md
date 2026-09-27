<!-- verbatim-ai:artifact:v1 issue=73 phase=spec id=issue-0073-issue-0073-26ee9233-69e6-422a-91ec-58e164dd5859-SPEC-003 display=SPEC-003 run=issue-0073-26ee9233-69e6-422a-91ec-58e164dd5859 -->
# SPEC-003: Architect spec

- Issue: #73
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0073-issue-0073-26ee9233-69e6-422a-91ec-58e164dd5859-SPEC-003
- Agent: architect
- Run: issue-0073-26ee9233-69e6-422a-91ec-58e164dd5859
- Created: 2026-07-24T14:58:30.858Z

## Summary

Spec

## Body

# Spec

● skill(doc-coauthoring)

```markdown
# Spec: Warn on Global Hotkey Conflicts Where Detectable

## Objective

Verbatim AI should give users actionable feedback when their selected global recording shortcut is unlikely to work because it conflicts with another shortcut.

This is a **warn-and-pick-another** feature, not an override feature. Operating systems do not provide a safe or reliable way for Verbatim AI to override another app’s global shortcut registration.

Success means:

- On **Windows**, if the selected shortcut is already registered by another app and Tauri/global-hotkey reports registration failure, Settings shows a clear “already in use” message.
- On **macOS**, Settings warns for a curated set of well-known reserved/system shortcuts, while making no claim to detect arbitrary cross-app conflicts.
- Existing same-app stale registration recovery remains supported.
- The overlay/recording pipeline behavior is unchanged for valid shortcuts.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- Rust backend in `src-tauri/`
- React/TypeScript frontend in `src/`
- Settings UI in `src/routes/Settings.tsx`
- Global hotkey registration handled by `src-tauri/src/commands/hotkey.rs`
- Frontend hotkey event handling in `src/lib/hotkey.ts`
- Recording bridge in `src/lib/recording-bridge.ts`
- Overlay window in `src/overlay/Overlay.tsx`

Current relevant behavior:

- `set_hotkey` registers shortcuts through `tauri-plugin-global-shortcut`.
- The Rust command currently treats an `"already registered"` failure as possibly stale same-app state and swallows/retries around it.
- The frontend currently shows a generic failure message similar to “Couldn't register that shortcut.”
- Dependency versions noted for this feature:
  - `tauri-plugin-global-shortcut 2.3.1`
  - `global-hotkey 0.7.0`

## Problem

Users can currently select a global hotkey that is already unavailable or reserved. When registration fails, Verbatim AI does not explain why or what the user should do.

Platform constraints:

- **Windows:** conflicts are detectable when `RegisterHotKey` fails because another process already registered the same key combination.
- **macOS:** arbitrary cross-app shortcut conflicts are not reliably detectable through the registration API. Multiple apps may register the same shortcut, and some shortcuts are system-reserved or conventionally owned by macOS.
- **fn/right-⌘ path:** event-tap-style hotkey paths do not have the same registration/failure semantics and should not be treated as conflict-detectable.

## Proposed Architecture

### Rust backend

Add typed error handling to `src-tauri/src/commands/hotkey.rs` so the frontend can distinguish:

| Error kind | Meaning | Frontend behavior |
|---|---|---|
| `already_in_use` | Windows registration failed after stale same-app recovery attempt | Show “already used by another app” |
| `invalid_hotkey` | Shortcut string cannot be parsed or represented | Show invalid shortcut message |
| `registration_failed` | Unknown plugin/global-hotkey failure | Show generic failure message |

Recommended flow for Windows registration:

1. Attempt to register the requested shortcut.
2. If registration succeeds, persist/update state as today.
3. If registration fails with an “already registered” style error:
   - Attempt same-app stale cleanup using the existing unregister/re-register approach.
   - If retry succeeds, treat as recovered stale same-app state.
   - If retry still fails with the same conflict signal, return `already_in_use`.
4. For other failures, return `registration_failed`.

Do not attempt to override or unregister another app’s hotkey.

### Frontend

Add a small hotkey conflict/reserved-shortcut helper, for example:

- `src/lib/hotkeyConflicts.ts`

Responsibilities:

- Normalize accelerator strings into a predictable internal shape.
- Detect known macOS reserved shortcuts.
- Map backend error codes to user-facing copy.
- Keep platform-specific messaging centralized.

Example TypeScript shape:

```ts
export type [REDACTED] 'already_in_use'
  | 'invalid_hotkey'
  | 'registration_failed';

export interface HotkeyWarning {
  severity: 'warning' | 'error';
  title: string;
  message: string;
}
```

Settings should use this helper when:

1. The user captures/selects a new shortcut.
2. The app attempts to save/register the shortcut.
3. The backend returns a typed registration error.

### macOS reserved shortcut warning list

Start with a conservative curated list. Examples:

- `Meta+Space` / `Command+Space` — Spotlight
- `Meta+Tab` — app switcher
- `Meta+Shift+3` — screenshot
- `Meta+Shift+4` — screenshot selection
- `Meta+Shift+5` — screenshot controls
- `Ctrl+Meta+Space` — character viewer / emoji picker
- `Meta+Option+Esc` — force quit
- `Meta+Comma` should **not** be blocked; it is app-local convention, not global reserved behavior.

The warning should say best-effort, for example:

> This shortcut is commonly reserved by macOS and may not work reliably. Choose a different shortcut.

Do not say Verbatim AI detected another app using it on macOS.

## UX Copy

### Windows conflict

Title:

> Shortcut already in use

Message:

> Another app is already using this global shortcut. Choose a different shortcut for Verbatim AI.

### macOS reserved shortcut

Title:

> Shortcut may be reserved by macOS

Message:

> This shortcut is commonly used by macOS and may not work reliably as a Verbatim AI recording shortcut.

### Generic registration failure

Title:

> Couldn’t register shortcut

Message:

> Verbatim AI couldn’t register that shortcut. Choose a different shortcut and try again.

## Security and Privacy

- Do not enumerate running apps to identify which app owns a shortcut.
- Do not log full foreground window titles or app names as part of conflict detection.
- Do not introduce accessibility permissions or event taps solely for conflict detection.
- Do not attempt to override, unregister, or interfere with another process’s shortcuts.
- Keep error messages generic; do not expose OS internals or raw plugin errors to users.
- Treat shortcut strings as user-controlled input:
  - parse/validate them before use,
  - avoid shell execution,
  - avoid writing raw errors containing unexpected content directly into UI.

## Tests

### Rust tests

Add or update tests around hotkey error classification where practical:

- Classifies “already registered” / equivalent global-hotkey error as conflict after retry failure.
- Preserves same-app stale registration recovery behavior.
- Returns generic registration failure for unknown errors.
- Does not classify unrelated plugin failures as `already_in_use`.

If direct plugin integration is difficult to unit test, isolate the string/error classification into a small pure helper and test that helper.

### TypeScript tests

Add tests for the frontend helper:

- macOS reserved shortcuts are detected.
- Non-reserved shortcuts do not warn.
- Windows does not use the macOS reserved list.
- Backend `already_in_use` maps to the Windows conflict message.
- Unknown backend errors map to the generic message.
- Accelerator normalization handles modifier ordering consistently.

### Manual verification

Run:

```bash
pnpm lint
pnpm build
```

If Rust logic changes are non-trivial, also run the relevant Tauri/Rust checks available in the repo, for example:

```bash
cd src-tauri && cargo test
```

## Screenshots

Capture or update screenshots for the implementation PR/spec evidence:

1. **Windows conflict error**
   - Settings hotkey picker showing “Shortcut already in use.”
   - Use a known occupied shortcut or a test harness/manual setup where another process registers the shortcut first.

2. **macOS reserved warning**
   - Settings hotkey picker showing a reserved-shortcut warning for `⌘ Space`.

3. **Valid shortcut success state**
   - Settings showing a non-reserved, successfully registered shortcut with no warning.

Screenshots should avoid personal data, visible window titles, emails, names, or unrelated desktop content.

## Acceptance Criteria

- Windows detects a registration failure caused by an already-registered global shortcut where the OS/plugin exposes that failure.
- Windows displays a specific “already in use” message instead of the generic registration error.
- Same-app stale registration recovery still works.
- macOS displays warnings for the curated reserved shortcut list.
- macOS UI copy clearly communicates best-effort reserved-shortcut warning, not cross-app conflict detection.
- No implementation attempts to override another app’s shortcut.
- No implementation attempts to identify which app owns a shortcut.
- Existing valid hotkey registration behavior remains unchanged.
- Existing recording hotkey press/release flow remains unchanged.
- Tests cover backend error classification and frontend warning/message mapping.
- `pnpm lint`, `pnpm build`, and applicable Rust tests pass.

## Boundaries

### Always do

- Preserve existing hotkey registration behavior for valid shortcuts.
- Use typed errors between Rust and frontend instead of matching raw user-facing strings in React.
- Keep platform-specific behavior explicit.
- Use clear UX copy that tells users what action to take.

### Ask first

- Adding new dependencies.
- Changing the global shortcut plugin.
- Adding new macOS permissions.
- Changing the default recording shortcut.
- Introducing app/process enumeration.

### Never do

- Claim arbitrary macOS shortcut conflict detection is reliable.
- Override or unregister another app’s shortcut.
- Log raw OS/plugin errors containing unexpected user/system data.
- Add screenshot artifacts containing PII.
- Change unrelated recording, overlay, transcription, or paste behavior.

## Open Questions

- Should macOS reserved-shortcut warnings block saving, or allow saving with warning? Recommended: allow saving but warn.
- Should Windows `already_in_use` block saving? Recommended: yes, because the shortcut cannot be registered.
- Should the reserved shortcut list be user-visible in documentation, or only enforced in UI copy? Recommended: UI only unless users ask for troubleshooting docs.
```

