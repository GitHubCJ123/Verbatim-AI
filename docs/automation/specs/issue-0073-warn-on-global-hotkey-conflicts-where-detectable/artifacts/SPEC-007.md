<!-- verbatim-ai:artifact:v1 issue=73 phase=spec id=issue-0073-issue-0073-27cbdc85-80da-4659-a422-a319ed0705c5-SPEC-007 display=SPEC-007 run=issue-0073-27cbdc85-80da-4659-a422-a319ed0705c5 -->
# SPEC-007: Architect spec

- Issue: #73
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0073-issue-0073-27cbdc85-80da-4659-a422-a319ed0705c5-SPEC-007
- Agent: architect
- Run: issue-0073-27cbdc85-80da-4659-a422-a319ed0705c5
- Created: 2026-07-25T07:28:49.782Z

## Summary

Spec

## Body

# Spec

Proposed content for `docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/spec.md`:

```markdown
# Spec: Warn on Global Hotkey Conflicts Where Detectable

## Objective

Verbatim AI should provide clearer feedback when a user configures a global hotkey that cannot or should not be used.

The feature is a warning/error improvement, not an override feature. Operating systems do not provide a reliable or safe way for Verbatim AI to override another app's registered global shortcut. Success means users understand when a shortcut is unavailable or likely reserved and can choose a different shortcut.

## Problem

Today, hotkey registration failures are surfaced generically as "Couldn't register that shortcut." This does not distinguish between:

1. A stale same-app registration that can be cleared and retried.
2. A shortcut already registered by another application on Windows.
3. A macOS shortcut that is known to be reserved or commonly owned by the system.
4. Other unexpected registration failures.

This creates confusing UX when a selected shortcut silently fails or appears unsupported without explaining why.

## Current Repo Facts

- Verbatim AI is a Tauri 2 desktop app with:
  - Rust backend in `src-tauri/`
  - React/TypeScript frontend in `src/`
  - Settings UI in the `main` window
  - Recording overlay in a separate `overlay` window
- Global shortcut registration is handled in Rust by `src-tauri/src/commands/hotkey.rs`.
- Settings UI hotkey save behavior is handled in `src/routes/Settings.tsx`.
- The app currently uses:
  - `tauri-plugin-global-shortcut 2.3.1`
  - `global-hotkey 0.7.0`
- Existing behavior includes swallowing an `"already registered"` error in the Rust hotkey command to handle stale same-app registration.
- Frontend currently shows a generic registration failure message for remaining errors.
- The app has a special macOS `fn` / right-command path that uses event-tap behavior rather than normal global-shortcut registration.

## Assumptions

1. The existing hotkey persistence model should remain unchanged.
2. This feature should not add new dependencies unless implementation proves existing APIs are insufficient.
3. The main user-facing change should be clearer messaging in Settings.
4. Windows conflict detection should rely on registration failure from the existing global shortcut registration path.
5. macOS arbitrary cross-app conflict detection is out of scope because the platform API does not reliably expose it.
6. The macOS reserved shortcut list should be intentionally small and conservative to avoid false positives.

## Tech Stack

- Frontend: React, TypeScript, Zustand, Vite
- Backend: Rust, Tauri 2
- Shortcut integration: `tauri-plugin-global-shortcut`, `global-hotkey`
- Validation commands:
  - Build frontend: `pnpm build`
  - Lint frontend: `pnpm lint`
  - Tauri/Rust check, if available in existing project workflow: `pnpm tauri build` or targeted `cargo check` from `src-tauri/`

## Architecture

### Backend

Update the Rust hotkey command layer so registration failures are classified into stable, frontend-consumable error categories.

Recommended shape:

```rust
enum HotkeyRegistrationError {
    AlreadyInUse,
    ReservedShortcut,
    InvalidShortcut,
    RegistrationFailed,
}
```

The exact implementation can use the repo's existing Tauri error serialization conventions rather than exposing this enum directly if that better matches current code.

Windows behavior:

- Attempt registration through the existing `tauri-plugin-global-shortcut` path.
- Preserve the existing stale same-app cleanup/retry behavior.
- If registration still fails with the platform/plugin error that indicates the shortcut is already registered, return a distinct conflict error.
- Do not claim Verbatim AI can override the shortcut.
- Do not attempt to forcibly unregister another application's hotkey.

macOS behavior:

- Do not attempt generic cross-app conflict detection.
- Add a best-effort reserved shortcut check before or around registration for a curated list of known system shortcuts.
- Reserved shortcut detection should return a warning/error category that the frontend can translate into clear UX.
- The `fn` / right-command event-tap path should be handled separately and should not be treated as a normal registration conflict.

Suggested reserved macOS shortcuts, subject to product review:

| Shortcut | Reason |
|---|---|
| `Meta+Space` / `Cmd+Space` | Spotlight |
| `Meta+Tab` / `Cmd+Tab` | App switcher |
| `Meta+Backtick` / `Cmd+\`` | Window switcher |
| `Meta+Option+Esc` / `Cmd+Option+Esc` | Force Quit |
| `Ctrl+Meta+Space` / `Ctrl+Cmd+Space` | Character Viewer on many systems |

Keep this list conservative. Avoid broad blocking of common app-level shortcuts unless there is high confidence they are system-reserved.

### Frontend

Update Settings hotkey save handling to display specific messages based on the backend error category.

Suggested copy:

| Error category | User-facing message |
|---|---|
| Windows conflict | `That shortcut is already in use by another app. Choose a different shortcut.` |
| macOS reserved | `That shortcut is reserved by macOS or commonly used by the system. Choose a different shortcut.` |
| invalid shortcut | `That shortcut is not supported. Choose a different shortcut.` |
| fallback failure | `Couldn't register that shortcut. Choose a different shortcut and try again.` |

If the existing Settings UI has toast, inline validation, or status-message patterns, reuse them rather than adding a new presentation pattern.

### Shared Contract

The backend should return stable machine-readable error identifiers, not rely on frontend parsing of raw platform/plugin strings.

Example contract:

```ts
type [REDACTED] "already-in-use"
  | "reserved-shortcut"
  | "invalid-shortcut"
  | "registration-failed";
```

The concrete serialization may differ, but the frontend should branch on stable codes.

## Security and Privacy

- Do not inspect other running applications to determine shortcut ownership.
- Do not enumerate windows, processes, accessibility state, or input-monitoring state for this feature.
- Do not log full raw platform errors if they may include environment-specific details.
- Do not attempt to unregister or override shortcuts owned by other applications.
- Keep macOS detection as a static local reserved-shortcut check.
- Avoid adding permissions such as Accessibility or Input Monitoring solely for conflict detection.
- Any logging should be consistent with existing app logging and should avoid leaking user-specific app state.

## Testing Strategy

### Rust/backend tests

Add targeted tests around hotkey error classification if the relevant logic can be factored into pure functions.

Suggested cases:

1. Stale same-app `"already registered"` case still retries/clears according to existing behavior.
2. Windows-style repeated registration failure maps to `already-in-use`.
3. Unknown registration error maps to `registration-failed`.
4. macOS reserved shortcut matcher identifies curated reserved shortcuts.
5. macOS reserved shortcut matcher does not overmatch unrelated shortcuts.

### Frontend tests

If existing frontend test infrastructure covers Settings behavior, add tests for message mapping:

1. `already-in-use` displays the specific conflict message.
2. `reserved-shortcut` displays the macOS reserved shortcut message.
3. Unknown errors keep the existing generic fallback.
4. Successful save behavior remains unchanged.

### Manual verification

Windows:

1. Register a known shortcut in another app.
2. Attempt to set the same shortcut in Verbatim AI.
3. Confirm the app shows the "already in use" message.
4. Confirm the previous working hotkey remains intact if the new hotkey fails.

macOS:

1. Attempt to set `Cmd+Space`.
2. Confirm the app warns that the shortcut is reserved or system-owned.
3. Attempt to set a normal non-reserved shortcut.
4. Confirm registration behavior is unchanged.

Regression:

1. Set a valid shortcut.
2. Change to another valid shortcut.
3. Restart the app.
4. Confirm the configured shortcut still works.

## Screenshots

Capture screenshots after implementation for the automation record:

1. Windows Settings UI showing the conflict message for a shortcut already used by another app.
2. macOS Settings UI showing the reserved shortcut message for a known system shortcut.
3. Settings UI showing successful registration of a valid shortcut.

If platform access is unavailable during implementation, include screenshots for the platform under test and document the missing platform as not captured.

## Boundaries

### Always do

- Preserve existing valid-hotkey behavior.
- Preserve stale same-app registration handling.
- Use stable backend error codes for frontend branching.
- Keep messaging accurate: warn and ask the user to choose another shortcut.
- Run targeted build/lint/test checks before completion.

### Ask first

- Adding new dependencies.
- Adding OS permissions.
- Expanding macOS reserved shortcuts beyond a small conservative list.
- Changing hotkey storage format.
- Changing onboarding or first-run UX.

### Never do

- Claim the app can override another application's shortcut.
- Attempt to unregister shortcuts owned by other apps.
- Use process/window scanning to infer hotkey ownership.
- Parse raw localized OS error strings in frontend code.
- Add broad or noisy shortcut blocklists that prevent legitimate user choices.

## Acceptance Criteria

1. On Windows, when the selected shortcut is already registered by another app and registration fails, the user sees a specific "already in use by another app" message.
2. Existing stale same-app registration recovery continues to work.
3. On macOS, selected shortcuts from the curated reserved list produce a clear reserved/system shortcut warning.
4. The app does not attempt arbitrary macOS cross-app shortcut conflict detection.
5. The app does not attempt to override or unregister another app's hotkey.
6. Generic registration failures still show a safe fallback error.
7. A failed hotkey change does not leave the app with a broken or partially updated shortcut configuration.
8. Tests cover backend error classification and frontend message mapping where existing test infrastructure allows.
9. Screenshots or documented screenshot gaps are included with the implementation record.
```

