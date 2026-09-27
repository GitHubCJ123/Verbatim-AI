<!-- verbatim-ai:artifact:v1 issue=73 phase=spec id=issue-0073-issue-0073-54a3b0f0-68c2-4a24-8efb-4db55243167e-SPEC-004 display=SPEC-004 run=issue-0073-54a3b0f0-68c2-4a24-8efb-4db55243167e -->
# SPEC-004: Architect spec

- Issue: #73
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0073-issue-0073-54a3b0f0-68c2-4a24-8efb-4db55243167e-SPEC-004
- Agent: architect
- Run: issue-0073-54a3b0f0-68c2-4a24-8efb-4db55243167e
- Created: 2026-07-24T19:02:55.358Z

## Summary

Spec

## Body

# Spec

Below is proposed content for `docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/spec.md`.

```markdown
# Spec: Warn on Global Hotkey Conflicts Where Detectable

## Assumptions

1. The product goal is to prevent users from believing a global shortcut is active when the OS rejected or may reserve it.
2. The app should not claim it can override another app's global hotkey, because supported OS APIs do not provide reliable override semantics.
3. Windows conflict detection should rely on the existing global hotkey registration path rather than adding a new dependency.
4. macOS cross-app conflict detection is best-effort only; the reliable scope is warning for known reserved/system shortcuts.
5. The feature should preserve the existing hotkey settings flow and only improve validation, warning copy, and platform-specific handling.

## Objective

Warn users when their selected global hotkey is unlikely to work:

- On **Windows**, detect registration failures that indicate the shortcut is already registered by another app and show a specific “already in use” message.
- On **macOS**, warn for a curated list of reserved or well-known system shortcuts, while making no claim to detect arbitrary cross-app conflicts.
- Preserve the existing same-app stale-registration recovery behavior.
- Reframe UX from “override another app’s shortcut” to “this shortcut cannot be used reliably; choose another.”

Success means users receive clear, platform-accurate feedback before saving or immediately when saving a shortcut that cannot be registered reliably.

## Current Repo Facts

- Verbatim AI is a Tauri 2 desktop app with:
  - Rust backend under `src-tauri/`
  - React/TypeScript frontend under `src/`
  - Settings UI in `src/routes/Settings.tsx`
  - Hotkey command implementation in `src-tauri/src/commands/hotkey.rs`
- Global shortcuts are registered through `tauri-plugin-global-shortcut`.
- Current versions:
  - `tauri-plugin-global-shortcut 2.3.1`
  - `global-hotkey 0.7.0`
- Current backend behavior:
  - `set_hotkey` registers the shortcut through the plugin.
  - It currently treats an `"already registered"` failure as a possible stale same-app registration case and retries after unregistering.
  - Other failures are surfaced generically.
- Current frontend behavior:
  - Settings currently shows generic copy similar to “Couldn't register that shortcut” when registration fails.
  - There is no dedicated conflict message and no macOS reserved-shortcut warning list.
- Existing architecture already routes hotkey configuration through the Rust command layer, so conflict classification should live near registration, while user-facing copy should live in the Settings UI.

## Tech Stack

- Frontend: React, TypeScript, Vite, Zustand
- Desktop shell/backend: Tauri 2, Rust
- Global hotkeys: `tauri-plugin-global-shortcut`, `global-hotkey`
- Styling: CSS custom properties from `src/styles/tokens.css`; do not introduce hard-coded colors outside existing conventions.

## Commands

Use existing repo commands only:

```bash
pnpm lint
pnpm build
pnpm tauri build
```

Targeted validation may use narrower existing commands if available, but no new build, lint, or test tooling should be introduced for this issue.

## Project Structure

Expected implementation areas:

```text
src-tauri/src/commands/hotkey.rs
  Rust command that registers/unregisters global hotkeys and should classify registration errors.

src/routes/Settings.tsx
  Settings UI where shortcut selection and registration errors are presented to the user.

src/lib/
  Shared frontend helpers may live here if reserved-shortcut detection needs to be reused or tested.

src/**/*.test.ts / src/**/*.test.tsx
  Frontend tests, if this repo already has a matching test convention.

src-tauri/
  Rust tests, if there is an existing convention for command/helper tests.
```

Do not create unrelated architectural layers for this feature.

## Proposed Architecture

### 1. Backend registration outcome classification

Update the Rust hotkey registration path to return a structured error that distinguishes:

- `already_in_use`
- `invalid_hotkey`
- `unsupported_hotkey`
- `registration_failed`

The classification should be conservative. Only return `already_in_use` when the backend can confidently determine the OS/plugin error corresponds to the shortcut being unavailable because another registration owns it.

Windows behavior:

1. Attempt to register the requested hotkey.
2. If registration succeeds, persist/apply the hotkey as today.
3. If registration fails with the known “already registered” shape:
   - First run the existing stale same-app recovery path.
   - If unregister/retry succeeds, treat it as success.
   - If retry still fails, classify as `already_in_use`.
4. If registration fails for another reason, return a structured generic failure.

macOS behavior:

- Do not classify arbitrary registration success as proof that there is no conflict.
- Do not claim cross-app conflict detection.
- Continue to surface true registration errors, but arbitrary cross-app duplicates are out of scope because the platform API does not reliably reject them.

### 2. Frontend reserved-shortcut detection for macOS

Add a small curated warning list for macOS shortcuts that are commonly reserved by the system.

Initial candidates:

```text
Cmd+Space          Spotlight
Cmd+Option+Space   Finder search / system search behavior
Ctrl+Cmd+Space     Character Viewer / Emoji & Symbols
Cmd+Tab            App switcher
Cmd+Shift+3        Screenshot
Cmd+Shift+4        Screenshot selection
Cmd+Shift+5        Screenshot toolbar
Cmd+Option+Esc     Force Quit Applications
```

The implementation should normalize shortcut representation before matching so equivalent modifier ordering does not bypass warnings.

The warning should be best-effort and should say that macOS may reserve this shortcut, not that the app definitively detected another app using it.

### 3. User-facing copy

Windows conflict copy should be direct:

> This shortcut is already in use by another app. Choose a different shortcut.

macOS reserved-shortcut copy should be best-effort:

> macOS may reserve this shortcut, so Verbatim AI may not receive it reliably. Choose a different shortcut for best results.

Generic fallback copy should remain available:

> Couldn't register that shortcut. Choose a different shortcut and try again.

Avoid “override” language anywhere in the implementation.

### 4. Data flow

```text
User selects shortcut in Settings
        |
        v
Frontend normalizes shortcut
        |
        +--> macOS only: check curated reserved list and show warning
        |
        v
Frontend invokes set_hotkey Tauri command
        |
        v
Rust attempts plugin registration
        |
        +--> success: save/apply shortcut
        |
        +--> stale same-app registration: unregister/retry, then success if retry works
        |
        +--> Windows genuine taken shortcut: structured already_in_use error
        |
        +--> other failure: structured generic error
        |
        v
Frontend maps structured result to platform-accurate message
```

## Code Style

Prefer small typed classification helpers over string matching spread through UI code.

Example TypeScript style:

```ts
type [REDACTED] { kind: 'none' }
  | { kind: 'macos-reserved'; shortcutName: string };

function getReservedHotkeyWarning(platform: string, shortcut: string): HotkeyWarning {
  if (platform !== 'macos') return { kind: 'none' };

  const normalized = normalizeShortcut(shortcut);
  const reserved = MACOS_RESERVED_SHORTCUTS[normalized];

  return reserved
    ? { kind: 'macos-reserved', shortcutName: reserved }
    : { kind: 'none' };
}
```

Example Rust style:

```rust
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HotkeyRegistrationError {
    AlreadyInUse { shortcut: String },
    InvalidHotkey { shortcut: String },
    UnsupportedHotkey { shortcut: String },
    RegistrationFailed { shortcut: String, message: String },
}
```

Use existing project naming, formatting, and serialization conventions if they differ from these examples.

## Security and Privacy

- Do not log full diagnostic dumps from OS/plugin errors if they could contain unrelated system details.
- Do not expose process names, app names, window titles, or other app metadata as part of conflict detection.
- Do not attempt to enumerate other applications’ registered shortcuts.
- Do not add elevated permissions, accessibility permission prompts, event taps, or background monitoring for this issue.
- Do not add a dependency that inspects other processes or captures keyboard input.
- Error messages should be minimal and user-actionable.
- The feature must not weaken existing hotkey registration or unregister behavior.

## Testing Strategy

### Rust/backend tests

Add unit tests around any new classification helper if the codebase supports Rust tests.

Test cases:

1. Known “already registered” error string is classified as `already_in_use` only after stale same-app recovery fails.
2. Same-app stale registration recovery still succeeds when unregister/retry succeeds.
3. Unknown registration error maps to generic `registration_failed`.
4. Invalid shortcut parse errors remain distinct from conflict errors if currently distinguishable.

If direct plugin behavior is hard to unit test, isolate classification logic into a helper that can be tested without invoking OS registration.

### Frontend tests

Add tests for shortcut normalization and macOS reserved warning behavior if there is an existing frontend test setup.

Test cases:

1. `Cmd+Space` warns on macOS.
2. Modifier order normalization works, e.g. `Space+Cmd` or equivalent internal ordering maps to `Cmd+Space`.
3. Reserved macOS shortcuts do not warn on Windows.
4. Non-reserved shortcuts do not warn.
5. Backend `already_in_use` error maps to the specific Windows conflict copy.
6. Unknown backend error maps to generic failure copy.

### Manual validation

Windows:

1. Register a shortcut in another app.
2. Attempt to set the same shortcut in Verbatim AI.
3. Confirm Verbatim AI shows “already in use” copy and does not claim the shortcut was saved.
4. Confirm changing to an unused shortcut succeeds.

macOS:

1. Attempt to set `Cmd+Space`.
2. Confirm reserved-shortcut warning appears.
3. Attempt to set a non-reserved shortcut.
4. Confirm no reserved warning appears.
5. Confirm arbitrary duplicate detection is not claimed.

## Screenshots

Capture or update screenshots for the issue/PR if UI copy changes visibly:

1. Windows conflict error state in Settings.
2. macOS reserved-shortcut warning state in Settings.
3. Normal successful shortcut configuration state, if existing screenshots need comparison.

Screenshots should avoid exposing personal app names, usernames, window titles, or other local machine data.

## Boundaries

### Always do

- Preserve existing same-app stale-registration recovery.
- Use platform-accurate language.
- Keep arbitrary macOS cross-app conflict detection explicitly out of scope.
- Prefer structured backend errors over frontend string parsing.
- Validate shortcut normalization with tests where possible.

### Ask first

- Adding new dependencies.
- Adding OS-level keyboard monitoring, event taps, or accessibility permission flows.
- Changing the persisted hotkey format.
- Reworking the entire hotkey settings UI.
- Changing default hotkeys.

### Never do

- Claim Verbatim AI can override another app’s global hotkey.
- Enumerate other apps’ shortcuts.
- Store or report other apps’ window titles/process metadata for this feature.
- Swallow registration failures and present the shortcut as active.
- Add broad catch-all fallbacks that make failed registration look successful.

## Acceptance Criteria

1. On Windows, when the selected shortcut is already registered by another app and the plugin registration fails, Settings shows a specific “already in use” message.
2. The existing stale same-app registration recovery path still works and does not incorrectly show a conflict warning.
3. On macOS, selecting a curated reserved system shortcut shows a best-effort warning before or during save.
4. On macOS, the UI does not claim arbitrary cross-app hotkey conflicts are detectable.
5. Generic registration failures still show a generic failure message.
6. The app never uses “override” language for global hotkeys.
7. No new permissions, process enumeration, or keyboard-monitoring behavior is introduced.
8. Existing lint/build commands pass.
9. Tests cover backend error classification and frontend reserved-shortcut warning behavior where the existing test infrastructure supports it.

## Open Questions

1. Should the macOS reserved-shortcut warning block saving, or allow saving with a warning? Recommended default: warn but allow only if the current app behavior already allows risky shortcuts; otherwise block consistently with other invalid shortcut states.
2. Should the curated macOS list be limited to the initial shortcuts above, or expanded from Apple Human Interface Guidelines/system defaults in a follow-up?
3. Does the current frontend have an established test framework for Settings UI copy, or should tests focus on extracted helper functions?
```

