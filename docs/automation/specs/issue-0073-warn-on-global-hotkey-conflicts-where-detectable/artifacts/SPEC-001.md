<!-- verbatim-ai:artifact:v1 issue=73 phase=spec id=issue-0073-issue-0073-f41cab33-b5f9-45da-9bc3-e389cf9b1b87-SPEC-001 display=SPEC-001 run=issue-0073-f41cab33-b5f9-45da-9bc3-e389cf9b1b87 -->
# SPEC-001: Architect spec

- Issue: #73
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0073-issue-0073-f41cab33-b5f9-45da-9bc3-e389cf9b1b87-SPEC-001
- Agent: architect
- Run: issue-0073-f41cab33-b5f9-45da-9bc3-e389cf9b1b87
- Created: 2026-07-24T06:48:14.053Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue #73 - Warn on Global Hotkey Conflicts Where Detectable

## Objective

Verbatim AI should give users clearer feedback when their selected global recording shortcut cannot or should not be used.

Today, if a shortcut registration fails, the settings UI shows a generic failure message. Users cannot tell whether the shortcut is invalid, already registered by this app, already used by another app, or reserved by the operating system.

This feature reframes the original “override conflicting shortcut” request into realistic platform behavior:

- **Windows:** detect registration failures that indicate another app already owns the shortcut and tell the user to choose another shortcut.
- **macOS:** warn for a curated list of known reserved/system shortcuts, because arbitrary cross-app conflict detection is not reliable through the available global shortcut APIs.
- **All platforms:** do not claim that Verbatim AI can override another application’s global hotkey.

Success means users get actionable, platform-accurate feedback before or during hotkey save, without breaking same-app stale registration recovery.

## Problem

Global hotkeys are OS-level resources. Verbatim AI currently lets users choose a hotkey, then attempts to register it through Tauri’s global shortcut plugin.

Current behavior has two UX gaps:

1. **Windows conflicts are not explained clearly.**
   If another application already registered the same shortcut, Windows registration should fail. The frontend currently surfaces only a generic error.

2. **macOS reserved shortcuts are not proactively warned.**
   macOS does not reliably reject duplicate cross-app global shortcuts through the same registration path. Some system shortcuts, however, are well-known and should be treated as reserved or high-risk.

Important platform constraint:

- Verbatim AI must not present “override” as possible. Another app’s already-registered global shortcut cannot be forcibly overridden through normal OS APIs.

## Current Repo Facts

Repository architecture:

- Verbatim AI is a **Tauri 2 desktop app**.
- Frontend: React + TypeScript under `src/`.
- Backend: Rust Tauri commands under `src-tauri/src/commands/`.
- Settings UI lives in `src/routes/Settings.tsx`.
- Global hotkey registration is handled by Rust command code in `src-tauri/src/commands/hotkey.rs`.
- Hotkey events are consumed by `src/lib/hotkey.ts`.
- The recording pipeline starts from global hotkey events, then uses `src/lib/recording-bridge.ts` to show the overlay and trigger recording.

Relevant current behavior from issue context:

- `set_hotkey` registers through `tauri-plugin-global-shortcut`.
- Current dependency versions:
  - `tauri-plugin-global-shortcut 2.3.1`
  - `global-hotkey 0.7.0`
- `src-tauri/src/commands/hotkey.rs` currently swallows an `"already registered"` error to recover from stale same-app registrations.
- `src/routes/Settings.tsx` currently shows a generic “Couldn't register that shortcut” style message for other registration failures.
- There is no platform-specific conflict or reserved-shortcut messaging today.

Commands used by this repo:

```bash
pnpm install
pnpm build
pnpm lint
pnpm tauri dev
pnpm tauri build
```

## Scope

### In Scope

1. Add platform-aware hotkey conflict/reserved-shortcut feedback.
2. Preserve existing recovery for stale same-app registrations.
3. Improve frontend messaging for hotkey save failures.
4. Add unit tests or targeted Rust/TypeScript tests where the repo already supports them.
5. Add manual QA coverage for Windows and macOS.

### Out of Scope

1. Overriding another application’s hotkey.
2. Fully reliable cross-app hotkey conflict detection on macOS.
3. Enumerating all OS or app-level shortcuts installed on a user’s machine.
4. Changing the global shortcut library unless strictly necessary.
5. Reworking the entire hotkey capture UI.

## Platform Behavior

### Windows

Windows uses `RegisterHotKey` semantics underneath the global shortcut stack. When another app already owns a shortcut, registration should fail.

Expected behavior:

- If registration fails because the shortcut is already registered by another process, Verbatim AI should show:

  > This shortcut is already in use by another app. Choose a different shortcut.

- If the failure appears to be stale same-app state, preserve the existing unregister/re-register recovery path.
- If the failure reason is unknown, show a generic but still actionable error.

### macOS

macOS global shortcut APIs do not reliably report cross-app conflicts. Multiple apps may register the same shortcut, and the API may not produce an “already taken” error.

Expected behavior:

- Add a best-effort reserved shortcut warning for known system shortcuts.
- Warning should happen before save where possible.
- The message should avoid promising complete conflict detection.

Example copy:

> This shortcut is commonly reserved by macOS and may not work reliably. Choose a different shortcut.

Reserved list should start small and conservative, for example:

| Shortcut | Reason |
|---|---|
| `Meta+Space` / `Cmd+Space` | Spotlight |
| `Meta+Tab` / `Cmd+Tab` | App switcher |
| `Meta+Q` / `Cmd+Q` | Quit app |
| `Meta+W` / `Cmd+W` | Close window/tab |
| `Meta+H` / `Cmd+H` | Hide app |
| `Meta+M` / `Cmd+M` | Minimize |
| `Meta+Option+Esc` / `Cmd+Option+Esc` | Force Quit |
| `Control+Meta+Space` / `Ctrl+Cmd+Space` | Character Viewer |

The final implementation should normalize shortcut representation before matching, so display labels and detection logic do not drift.

### fn / Right Command Path on macOS

If Verbatim AI has a separate fn/right-Command path based on a `CGEventTap`, that path does not use the same registration concept.

Expected behavior:

- Do not report “already in use by another app” for the event-tap path unless there is a real detection mechanism.
- Reserved-shortcut warnings should apply only to shortcut combinations represented through the normal hotkey configuration flow.

## Architecture

### Backend: Rust Hotkey Command

Primary file:

```text
src-tauri/src/commands/hotkey.rs
```

Recommended changes:

1. Introduce a structured error response for `set_hotkey`.
2. Preserve same-app stale registration handling.
3. Distinguish conflict-like registration failures on Windows from generic failures.
4. Return machine-readable error codes to the frontend.

Suggested error shape:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyRegistrationError {
    pub code: HotkeyRegistrationErrorCode,
    pub message: String,
    pub platform: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyRegistrationErrorCode {
    AlreadyInUse,
    ReservedShortcut,
    InvalidShortcut,
    RegistrationFailed,
}
```

The exact type names can follow existing repo conventions.

Important behavior:

- Do not rely only on brittle string matching unless the upstream library exposes no structured error.
- If string matching is necessary, isolate it in a helper such as:

```rust
fn is_already_registered_error(error: &str) -> bool {
    error.to_ascii_lowercase().contains("already registered")
}
```

- Document that this is based on current `global-hotkey` error text and should be revisited if the dependency changes.

### Frontend: Settings UI

Primary file:

```text
src/routes/Settings.tsx
```

Recommended changes:

1. Update hotkey save handling to recognize structured backend errors.
2. Show specific messages:
   - Windows conflict: already in use by another app.
   - macOS reserved shortcut: commonly reserved by macOS.
   - Generic failure: could not register shortcut.
3. Avoid saying “override.”
4. Ensure the selected shortcut is not persisted as active if registration fails.
5. Keep current success path unchanged.

Potential helper location:

```text
src/lib/hotkey.ts
```

or a new small helper near existing hotkey parsing/formatting code if one already exists.

Suggested frontend error mapping:

```ts
type [REDACTED] 'alreadyInUse'
  | 'reservedShortcut'
  | 'invalidShortcut'
  | 'registrationFailed'

function hotkeyErrorMessage(error: HotkeyRegistrationError): string {
  switch (error.code) {
    case 'alreadyInUse':
      return 'This shortcut is already in use by another app. Choose a different shortcut.'
    case 'reservedShortcut':
      return 'This shortcut is commonly reserved by macOS and may not work reliably. Choose a different shortcut.'
    case 'invalidShortcut':
      return 'This shortcut is not valid. Choose a different shortcut.'
    default:
      return "Couldn't register that shortcut. Choose a different shortcut."
  }
}
```

### macOS Reserved Shortcut Detection

Recommended implementation:

- Normalize the captured shortcut into a canonical representation.
- Match against a conservative blocklist.
- Keep the blocklist small and documented.
- Prefer warning before invoking backend registration if the UI has enough information.
- Backend validation can also enforce or return `reservedShortcut` if cross-window consistency is needed.

Potential helper:

```ts
const MACOS_RESERVED_SHORTCUTS = new Set([
  'Meta+Space',
  'Meta+Tab',
  'Meta+Q',
  'Meta+W',
  'Meta+H',
  'Meta+M',
  'Meta+Alt+Escape',
  'Control+Meta+Space',
])
```

Use the app’s existing modifier naming conventions rather than introducing conflicting labels.

## Security and Privacy

This feature does not require new network access, credentials, telemetry, or persistence of sensitive data.

Security requirements:

- Do not enumerate other running applications to guess shortcut ownership.
- Do not log foreground app names, window titles, or user-entered shortcuts beyond existing debug patterns.
- Do not add broad OS-level event monitoring beyond what already exists.
- Do not expose raw Rust error/debug output directly to users if it may contain platform-specific implementation details.
- Do not introduce shell calls for shortcut detection.
- Do not add dependencies unless necessary.

Privacy requirements:

- Error messages should be generic: “another app,” not a guessed app name.
- No shortcut conflict data should be sent to Supabase or external services.
- No screenshots or recordings should be captured as part of detection.

## Testing Strategy

### Rust Tests

Add focused tests around helper logic in `src-tauri/src/commands/hotkey.rs` if the crate test setup supports it.

Recommended cases:

1. Detects known “already registered” error strings.
2. Does not classify unrelated registration failures as conflicts.
3. Maps Windows conflict-like errors to `alreadyInUse`.
4. Maps unknown failures to `registrationFailed`.
5. Preserves stale same-app unregister/re-register handling.

Example command:

```bash
cd src-tauri && cargo test
```

### TypeScript Tests

If the repo has frontend unit test infrastructure, add tests for:

1. macOS reserved shortcut normalization.
2. reserved shortcut matching.
3. non-reserved shortcut not matching.
4. error-code-to-message mapping.

If no test runner exists for frontend units, keep the helper simple and cover through manual QA plus `pnpm build`.

Example commands:

```bash
pnpm build
pnpm lint
```

### Manual QA: Windows

1. Start another app or small test utility that registers a known global hotkey.
2. Open Verbatim AI settings.
3. Try to save the same shortcut.
4. Confirm Verbatim AI shows:

   > This shortcut is already in use by another app. Choose a different shortcut.

5. Confirm the failed shortcut is not treated as active.
6. Save a different available shortcut.
7. Confirm recording still starts and stops with the new shortcut.

### Manual QA: macOS

1. Open Verbatim AI settings.
2. Try to select `Cmd+Space`.
3. Confirm the UI warns that the shortcut is commonly reserved by macOS.
4. Confirm the warning does not claim Verbatim AI detected another app conflict.
5. Save a non-reserved shortcut.
6. Confirm recording still starts and stops with the new shortcut.
7. If fn/right-Command mode exists, confirm this change does not break that flow.

### Regression QA

1. Existing saved hotkeys continue to load.
2. Clearing a hotkey still works.
3. Re-saving the same Verbatim AI hotkey does not incorrectly show “another app.”
4. Overlay recording behavior remains unchanged after a valid shortcut save.

## Screenshot Requirements

Capture screenshots or screen recordings for the PR when implementation is complete.

Required screenshots:

1. **Windows conflict message**
   - Settings screen showing the “already in use by another app” message.

2. **macOS reserved shortcut warning**
   - Settings screen showing the reserved shortcut warning for `Cmd+Space`.

3. **Successful valid shortcut save**
   - Settings screen showing a non-reserved shortcut saved successfully.

Screenshots must not include personal data, account emails, private workspace names, or unrelated desktop content.

## Acceptance Criteria

1. On Windows, when global hotkey registration fails because the shortcut is already registered by another app, the user sees a specific “already in use by another app” message.
2. On Windows, Verbatim AI does not claim it can override another app’s shortcut.
3. On Windows, same-app stale registration recovery continues to work.
4. On macOS, the app warns for a conservative list of known reserved system shortcuts.
5. On macOS, the app does not claim arbitrary cross-app shortcut conflicts are reliably detectable.
6. Failed hotkey registration does not persist the failed shortcut as active.
7. Valid hotkey registration behavior remains unchanged.
8. The hotkey recording pipeline still receives `hotkey:down` and `hotkey:up` events after saving a valid shortcut.
9. User-facing messages are actionable and platform-accurate.
10. No new network calls, telemetry, or app-enumeration behavior is introduced.
11. Relevant Rust and/or TypeScript helper tests are added where existing test infrastructure supports them.
12. `pnpm build`, `pnpm lint`, and applicable Rust tests pass.

## Implementation Plan

1. Inspect current hotkey registration flow in `src-tauri/src/commands/hotkey.rs`.
2. Add structured hotkey registration error codes.
3. Preserve stale same-app unregister/re-register recovery.
4. Add Windows-specific conflict classification for registration failures.
5. Add macOS reserved shortcut helper using existing shortcut representation conventions.
6. Update `src/routes/Settings.tsx` to display specific messages.
7. Add targeted tests for error classification and reserved shortcut matching.
8. Run build, lint, and applicable tests.
9. Capture required screenshots.

## Boundaries

### Always Do

- Preserve existing valid hotkey behavior.
- Keep platform-specific behavior explicit.
- Use actionable user-facing copy.
- Normalize shortcuts before comparing them.
- Avoid leaking raw backend errors into UI.

### Ask First

- Adding new dependencies.
- Changing the global shortcut library.
- Reworking the hotkey capture UX.
- Adding telemetry or analytics.
- Expanding reserved shortcut detection beyond a conservative list.

### Never Do

- Claim Verbatim AI can override another app’s shortcut.
- Enumerate user apps or windows to infer ownership.
- Persist failed shortcuts as active.
- Send shortcut conflict information to external services.
- Add broad event monitoring beyond existing app behavior.

## Open Questions

1. Should macOS reserved shortcuts block saving entirely, or show a warning and allow the user to proceed?
   - Recommended default: block the most clearly reserved system shortcuts, or require explicit confirmation only if the existing settings UI already has a confirmation pattern.

2. Should the reserved shortcut list live in frontend only, backend only, or both?
   - Recommended default: frontend for immediate UX, backend only if multiple windows or command callers can save hotkeys directly.

3. Does the current project have frontend unit test infrastructure?
   - If yes, add unit tests for shortcut normalization and warning copy.
   - If no, rely on `pnpm build`, Rust tests, and manual QA for this issue.
```

