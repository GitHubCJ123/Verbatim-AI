<!-- verbatim-ai:artifact:v1 issue=73 phase=spec id=issue-0073-issue-0073-93aefca5-aaca-44df-8d36-a861979e02ea-SPEC-002 display=SPEC-002 run=issue-0073-93aefca5-aaca-44df-8d36-a861979e02ea -->
# SPEC-002: Architect spec

- Issue: #73
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0073-issue-0073-93aefca5-aaca-44df-8d36-a861979e02ea-SPEC-002
- Agent: architect
- Run: issue-0073-93aefca5-aaca-44df-8d36-a861979e02ea
- Created: 2026-07-24T10:53:23.425Z

## Summary

Spec

## Body

# Spec

Proposed content for `docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/spec.md`:

```markdown
# Spec: Warn on global-hotkey conflicts where detectable

## Objective

Verbatim AI should provide clearer feedback when a user chooses a global recording shortcut that cannot be safely used.

The goal is not to override another app's shortcut. Desktop operating systems do not provide a safe or reliable cross-platform "override" capability for global hotkeys. Instead, the app should:

1. Detect Windows registration failures that indicate the shortcut is already owned by another app.
2. Preserve the existing stale same-app registration handling.
3. Warn macOS users when they choose a known reserved system shortcut.
4. Keep arbitrary cross-app conflict detection on macOS out of scope because the platform APIs do not reliably expose it.

Success means users get actionable guidance: "this shortcut is already in use" or "this shortcut is reserved by macOS; choose another shortcut," rather than a generic registration failure.

## Current repo facts

- Verbatim AI is a Tauri 2 desktop app with a Rust backend under `src-tauri/` and React/TypeScript frontend under `src/`.
- Global shortcut registration is handled by the Rust command in `src-tauri/src/commands/hotkey.rs`.
- The app currently uses `tauri-plugin-global-shortcut 2.3.1` and `global-hotkey 0.7.0`.
- `set_hotkey` currently registers via the global shortcut plugin and intentionally swallows an `"already registered"` error in one stale same-app registration path.
- The Settings UI currently shows a generic failure message for shortcut registration errors in `src/routes/Settings.tsx`.
- The recording pipeline depends on the global hotkey emitting `hotkey:down` / `hotkey:up`, which is consumed by frontend hotkey handling and recording bridge code.
- macOS has an additional fn/right-command path based on event tapping rather than global shortcut registration, so it has no equivalent "registration conflict" failure mode.

## Tech stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript
- State/UI: existing Settings route and app stores
- Hotkey dependencies:
  - `tauri-plugin-global-shortcut 2.3.1`
  - `global-hotkey 0.7.0`

## Commands

Use the existing repository commands:

```bash
pnpm build
pnpm lint
pnpm tauri build
```

Targeted Rust checks may also be used from the Tauri crate when implementation changes Rust code:

```bash
cd src-tauri && cargo check
```

## Project structure

```text
src-tauri/src/commands/hotkey.rs
  Rust command responsible for registering, clearing, and managing global hotkeys.

src/routes/Settings.tsx
  UI surface where users configure the recording shortcut and receive registration feedback.

src/lib/hotkey.ts
  Frontend hotkey event handling.

src/lib/recording-bridge.ts
  Connects hotkey events to overlay recording behavior.

src/overlay/
  Overlay window that starts/stops capture after hotkey events.

docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/
  Spec and implementation documentation for this issue.
```

## Problem

Today, when a user configures a shortcut that cannot be registered, the app reports a generic failure. This is confusing because users cannot tell whether:

- the shortcut is already used by another app,
- the shortcut is reserved by the operating system,
- the app had a stale same-app registration,
- or some unrelated registration error occurred.

The original user-facing desire can be reframed as:

> Warn when a shortcut is unusable or likely reserved, and guide the user to choose another shortcut.

The app must not claim it can override another app's hotkey.

## Architecture

### Windows behavior

On Windows, global hotkey registration ultimately relies on `RegisterHotKey`. If another application already owns the same key combination, registration typically fails. This makes conflict detection feasible at registration time.

Implementation should:

1. Attempt to register the selected shortcut normally.
2. Preserve the existing stale same-app cleanup/retry behavior.
3. If registration still fails with an "already registered" / equivalent conflict error after stale-registration handling, classify the error as a detectable external conflict.
4. Return a structured error to the frontend rather than an undifferentiated string.
5. Show a clear Settings UI message such as:

```text
That shortcut is already in use by another app. Choose a different shortcut.
```

The UI should not say the app can override the shortcut.

### macOS behavior

macOS global hotkey APIs do not reliably fail when another app has registered the same shortcut. Multiple apps may register the same combination, and arbitrary cross-app conflict detection is not reliable.

Implementation should:

1. Add a small curated list of known reserved macOS shortcuts.
2. Check the selected shortcut against that list before or during save.
3. Show a warning or blocking validation message for known reserved shortcuts.
4. Avoid claiming that all macOS conflicts are detectable.

Initial reserved list should include high-confidence system shortcuts only, for example:

```text
Cmd+Space       Spotlight
Cmd+Tab         App switcher
Cmd+Shift+3     Screenshot
Cmd+Shift+4     Screenshot selection
Cmd+Shift+5     Screenshot toolbar
Ctrl+Cmd+Q      Lock screen
Cmd+Option+Esc  Force Quit Applications
```

The final list should be intentionally conservative to avoid false positives.

### Other platforms

For non-Windows and non-macOS platforms, preserve current behavior unless the existing platform-specific shortcut API exposes an equivalent reliable conflict signal.

### Error model

Introduce a typed registration outcome across the Rust/frontend boundary. Prefer explicit error kinds over parsing user-facing strings in React.

Suggested shape:

```ts
type [REDACTED] "already_in_use"
  | "reserved_shortcut"
  | "invalid_shortcut"
  | "registration_failed";
```

Rust should return enough structured information for the frontend to choose the right message.

Example response concept:

```json
{
  "kind": "already_in_use",
  "message": "That shortcut is already in use by another app."
}
```

Frontend copy should be generated from the typed kind where practical, not from raw backend error text.

## Code style

Prefer explicit classification helpers over inline string checks scattered through the command.

Example style:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyRegistrationErrorKind {
    AlreadyInUse,
    ReservedShortcut,
    InvalidShortcut,
    RegistrationFailed,
}

fn classify_registration_error(error: &str) -> HotkeyRegistrationErrorKind {
    if is_already_registered_error(error) {
        HotkeyRegistrationErrorKind::AlreadyInUse
    } else {
        HotkeyRegistrationErrorKind::RegistrationFailed
    }
}
```

Frontend code should keep user-facing copy near the Settings validation path:

```ts
function getHotkeyErrorMessage(kind: HotkeyRegistrationErrorKind): string {
  switch (kind) {
    case "already_in_use":
      return "That shortcut is already in use by another app. Choose a different shortcut.";
    case "reserved_shortcut":
      return "That shortcut is reserved by the operating system. Choose a different shortcut.";
    default:
      return "Couldn't register that shortcut. Choose a different shortcut.";
  }
}
```

## Security and privacy

- Do not enumerate running apps to identify which app owns a shortcut.
- Do not inspect other applications' windows, process names, or accessibility state for this feature.
- Do not request new macOS accessibility, input monitoring, or automation permissions for conflict detection.
- Do not log raw user environment details, foreground app details, or process lists as part of shortcut validation.
- Do not expose backend raw error strings directly if they may contain platform-specific implementation details.
- Keep all warnings local to the client; no shortcut choices should be sent to Supabase or external services for this feature.

## Testing strategy

### Rust tests

Add targeted tests around classification and platform-specific validation logic.

Coverage should include:

- stale same-app `"already registered"` handling remains accepted where currently intended,
- genuine post-retry registration conflict maps to `already_in_use` on Windows,
- unrelated registration failures map to `registration_failed`,
- macOS reserved shortcuts map to `reserved_shortcut`,
- non-reserved macOS shortcuts are not blocked.

### TypeScript/UI tests

Add tests for Settings error-message mapping if the repo already has a suitable frontend test setup. If not, keep the mapping small and deterministic enough to validate via build/typecheck.

Coverage should include:

- `already_in_use` displays "already in use by another app",
- `reserved_shortcut` displays "reserved by the operating system",
- unknown/generic errors preserve the existing generic fallback.

### Manual QA

Windows:

1. Configure a shortcut already registered by another app.
2. Confirm Verbatim AI does not save it as active.
3. Confirm the Settings UI says the shortcut is already in use by another app.
4. Configure a valid unused shortcut.
5. Confirm recording still starts/stops normally.

macOS:

1. Configure `Cmd+Space`.
2. Confirm the Settings UI warns that the shortcut is reserved.
3. Configure a non-reserved shortcut.
4. Confirm current registration behavior remains unchanged.
5. Confirm fn/right-command recording path is not regressed.

Regression:

1. Restart the app.
2. Confirm the previously saved valid shortcut still registers.
3. Confirm stale same-app registration handling still works and does not incorrectly report an external conflict.

## Screenshots

Capture screenshots after implementation for the issue/PR:

1. Windows Settings shortcut field showing the "already in use by another app" error.
2. macOS Settings shortcut field showing the "reserved by the operating system" warning.
3. Valid shortcut state after successful save, showing no warning.

Screenshots should avoid exposing personal data, app lists, account details, or desktop contents unrelated to the Settings UI.

## Boundaries

### Always do

- Preserve existing successful shortcut registration behavior.
- Preserve stale same-app registration recovery.
- Use typed errors or structured responses for new frontend messages.
- Keep macOS arbitrary cross-app conflict detection explicitly out of scope.
- Use conservative reserved-shortcut warnings to avoid noisy false positives.
- Run existing build/lint/check commands before completion.

### Ask first

- Adding new dependencies.
- Changing global shortcut libraries.
- Introducing new OS permissions.
- Expanding detection to process enumeration or accessibility APIs.
- Changing the shortcut capture UX beyond the warning/error messaging needed here.

### Never do

- Claim Verbatim AI can override another app's global shortcut.
- Send shortcut selections or conflict data to external services.
- Log sensitive local environment details.
- Add broad silent fallbacks that hide registration failures.
- Disable or weaken existing hotkey validation.

## Acceptance criteria

1. On Windows, when registration fails because the shortcut is already registered by another app, the Settings UI displays a specific "already in use by another app" message.
2. On Windows, stale same-app registration handling continues to work and is not misclassified as an external conflict.
3. On macOS, known reserved system shortcuts display a specific reserved-shortcut warning.
4. On macOS, the app does not claim to detect arbitrary cross-app shortcut conflicts.
5. Generic registration failures still show a safe fallback message.
6. Valid shortcuts can still be saved and used to start/stop recording.
7. No new OS permissions, process enumeration, or external network calls are introduced.
8. Existing frontend build/lint and relevant Rust checks pass.

## Open questions

1. Should macOS reserved shortcuts be hard-blocked or allowed after warning? Recommended default: block only the highest-confidence reserved shortcuts and use clear copy.
2. What exact reserved macOS shortcut list should ship initially? Recommended default: keep the first version small and high-confidence.
3. Should Windows conflict copy mention that the other app cannot be identified? Recommended default: no, keep the message short and actionable.
```

