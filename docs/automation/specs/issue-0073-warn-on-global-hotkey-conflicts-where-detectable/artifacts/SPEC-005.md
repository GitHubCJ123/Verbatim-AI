<!-- verbatim-ai:artifact:v1 issue=73 phase=spec id=issue-0073-issue-0073-c6d86f5c-3f3e-4831-a683-8caed921184d-SPEC-005 display=SPEC-005 run=issue-0073-c6d86f5c-3f3e-4831-a683-8caed921184d -->
# SPEC-005: Architect spec

- Issue: #73
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0073-issue-0073-c6d86f5c-3f3e-4831-a683-8caed921184d-SPEC-005
- Agent: architect
- Run: issue-0073-c6d86f5c-3f3e-4831-a683-8caed921184d
- Created: 2026-07-24T23:05:33.491Z

## Summary

Spec

## Body

# Spec

Proposed `docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/spec.md`:

```markdown
# Spec: Warn on Global Hotkey Conflicts Where Detectable

## Objective

Verbatim AI should give users clear feedback when their chosen global recording shortcut cannot or should not be used.

Today, users can choose a shortcut that appears valid in the settings UI but may fail at runtime because another app or the operating system already owns it. The app currently surfaces a generic registration error, which does not explain whether the shortcut is taken, unsupported, or otherwise invalid.

This feature reframes the request as **warn and pick another shortcut**, not override. Desktop operating systems do not provide a safe or reliable way for Verbatim AI to override another app’s registered global hotkey.

Success means:

- On **Windows**, when the OS/plugin reports that a shortcut is already registered by another process, the user sees a specific “already in use” message.
- On **macOS**, where arbitrary cross-app conflict detection is not reliable, the user sees a best-effort warning for known reserved or system-owned shortcuts.
- Existing same-app stale registration handling continues to work.
- The recording hotkey remains reliable across app restart and settings changes.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- Rust backend commands in `src-tauri/src/commands/`.
- React/TypeScript settings UI in `src/routes/Settings.tsx`.
- Global shortcut registration handled through `tauri-plugin-global-shortcut`.
- Hotkey events emitted from Rust and consumed by frontend code in `src/lib/hotkey.ts`.
- Recording flow bridged through `src/lib/recording-bridge.ts` into the overlay window.

Relevant current implementation:

- `src-tauri/src/commands/hotkey.rs` owns global shortcut registration.
- `set_hotkey` registers with the Tauri global shortcut plugin.
- The existing implementation intentionally swallows an `"already registered"` error in one path to tolerate stale same-app registrations.
- `src/routes/Settings.tsx` currently shows a generic “Couldn't register that shortcut” failure message.
- There is no platform-specific distinction between:
  - stale Verbatim registration,
  - another app already owning the shortcut,
  - reserved macOS/system shortcut,
  - invalid shortcut syntax.

Known dependency versions:

- `tauri-plugin-global-shortcut`: `2.3.1`
- `global-hotkey`: `0.7.0`

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript
- State: Zustand/localStorage-backed stores
- Styling: CSS custom properties from `src/styles/tokens.css`
- Package manager: pnpm
- Global hotkey implementation: `tauri-plugin-global-shortcut` / `global-hotkey`

## Commands

Primary verification commands:

```bash
pnpm build
pnpm lint
```

Manual desktop verification:

```bash
pnpm tauri dev
```

Rust/backend verification, if frontend build does not exercise the changed Rust code sufficiently:

```bash
cd src-tauri && cargo check
```

## Architecture

### Desired Behavior

#### Windows

Windows global hotkey registration uses OS semantics where `RegisterHotKey` typically fails if another process has already registered the same key combination.

The backend should distinguish:

1. **Stale same-app registration**
   - Verbatim previously registered the shortcut.
   - Re-registering after clearing/unregistering should be allowed.
   - Existing stale-registration tolerance should remain.

2. **Genuine external conflict**
   - Another app or process owns the shortcut.
   - Verbatim cannot override it.
   - The frontend should show a specific error:
     - “That shortcut is already in use by another app. Choose a different shortcut.”

The implementation should avoid claiming the app knows which other app owns the shortcut unless that is actually available from the OS/plugin, which it is not.

#### macOS

macOS global hotkey APIs do not reliably fail for arbitrary cross-app conflicts. Multiple apps may register the same key combination, and the API does not provide a dependable “already taken” signal.

Therefore macOS behavior should be best-effort:

1. Maintain a curated list of known reserved/system shortcuts.
2. Warn before or during save when the selected shortcut is known to conflict with common macOS behavior.
3. Do not claim arbitrary conflict detection is available.
4. Do not block all macOS saves solely because generic conflict detection is unavailable.

Suggested initial reserved list:

- `Cmd+Space` — Spotlight
- `Cmd+Option+Space` — Finder search / Spotlight-related system behavior
- `Cmd+Tab` — app switcher
- `Cmd+Shift+3` — screenshot
- `Cmd+Shift+4` — screenshot selection
- `Cmd+Shift+5` — screenshot/recording controls
- `Cmd+Option+Esc` — Force Quit
- `Ctrl+Up` — Mission Control
- `Ctrl+Down` — App Expose
- `Ctrl+Left` — previous Space
- `Ctrl+Right` — next Space

The list should be intentionally small and conservative. It is better to warn on well-known system shortcuts than to maintain a large fragile list that creates false positives.

#### fn / Right Command Path

If the app has a special fn/right-command path implemented through a CGEventTap rather than global-hotkey registration, it should not be treated as conflict-detectable. The spec does not require adding generic conflict detection for event taps.

If reserved shortcut validation applies to that path, it should be limited to normalized key combinations that are comparable with the curated macOS list.

## Proposed Design

### Backend: Structured Hotkey Registration Errors

Introduce a structured error shape for `set_hotkey` instead of relying on opaque string matching in the frontend.

Example conceptual shape:

```rust
#[derive(Debug, serde::Serialize)]
#[serde(tag = "code", content = "message")]
enum HotkeyRegistrationError {
    AlreadyInUse(String),
    InvalidShortcut(String),
    UnsupportedShortcut(String),
    RegistrationFailed(String),
}
```

Frontend-facing codes should be stable strings, for example:

- `already_in_use`
- `reserved_shortcut`
- `invalid_shortcut`
- `unsupported_shortcut`
- `registration_failed`

The backend should preserve enough message detail for logging/debugging while allowing the UI to show user-friendly copy.

### Backend: Windows Conflict Classification

On Windows, classify the relevant plugin/global-hotkey registration failure as `already_in_use` only when:

- the app has already attempted to clear/unregister its own existing shortcut, and
- registration still fails with the known “already registered” style error.

This preserves the current stale-registration behavior while giving users a useful message when the failure remains after cleanup.

The implementation should keep error matching as narrow as possible. Do not convert all registration failures into “already in use.”

### Frontend: User-Facing Error Copy

In `src/routes/Settings.tsx`, replace the generic failure message for known hotkey registration codes with specific copy.

Suggested messages:

| Error code | User-facing message |
|---|---|
| `already_in_use` | `That shortcut is already in use by another app. Choose a different shortcut.` |
| `reserved_shortcut` | `That shortcut is reserved by macOS. Choose a different shortcut.` |
| `invalid_shortcut` | `That shortcut is not valid. Choose a different shortcut.` |
| `unsupported_shortcut` | `That shortcut is not supported on this system. Choose a different shortcut.` |
| fallback | `Couldn't register that shortcut. Choose a different shortcut.` |

The UI should not offer an “override” action.

### Frontend or Shared Validation: macOS Reserved Shortcuts

Add a macOS-only reserved shortcut check before saving, or immediately after shortcut capture before invoking registration.

Preferred location:

- A small frontend utility near existing hotkey parsing/normalization code if shortcut normalization already exists there.
- Otherwise, a backend helper in `src-tauri/src/commands/hotkey.rs` if the backend has the canonical normalized hotkey representation.

The chosen location should avoid duplicating shortcut normalization logic.

The check should:

1. Normalize modifier order and key aliases.
2. Compare against the curated reserved list.
3. Return/show `reserved_shortcut` only on macOS.
4. Leave Windows/Linux behavior unchanged.

### Data Flow

1. User records or enters a shortcut in Settings.
2. Settings normalizes the shortcut using existing app conventions.
3. On macOS:
   - If the shortcut is in the reserved list, show the reserved warning and do not save/register it.
4. Settings invokes `set_hotkey`.
5. Rust unregisters/clears prior Verbatim shortcut state as it does today.
6. Rust attempts registration.
7. Rust returns success or a structured error code.
8. Settings displays specific user-facing copy.
9. On success, existing settings persistence and hotkey behavior continue unchanged.

## Security and Privacy

This feature must not introduce app enumeration, keylogging, or sensitive telemetry.

Security constraints:

- Do not scan running processes to identify which app owns a shortcut.
- Do not log raw user keystrokes beyond existing shortcut settings behavior.
- Do not add broad event taps for conflict detection.
- Do not request new accessibility/input-monitoring permissions for this feature.
- Do not send shortcut choices to any remote service.
- Do not include absolute paths, process names, active window titles, or user-specific app data in errors.
- Do not silently swallow registration failures except for the existing, intentional stale same-app recovery path.

The implementation should surface errors locally and deterministically.

## Testing Strategy

### Unit Tests

Add or update Rust tests where practical for:

- Classifying known “already registered” plugin errors as `already_in_use` only after same-app cleanup has been attempted.
- Preserving generic registration failures as `registration_failed`.
- macOS reserved-shortcut matching if implemented in Rust.

Add or update TypeScript tests where practical for:

- Mapping structured hotkey error codes to user-facing Settings messages.
- macOS reserved shortcut normalization if implemented in frontend code.
- Ensuring non-reserved shortcuts are not blocked.

### Manual Tests

#### Windows

1. Start another app or small test harness that registers a known global shortcut.
2. In Verbatim AI, attempt to set the same shortcut.
3. Confirm Verbatim shows:
   - `That shortcut is already in use by another app. Choose a different shortcut.`
4. Choose a different shortcut.
5. Confirm registration succeeds and recording still starts/stops correctly.

#### macOS

1. Attempt to set `Cmd+Space`.
2. Confirm Verbatim warns that the shortcut is reserved by macOS.
3. Attempt to set `Cmd+Shift+5`.
4. Confirm Verbatim warns that the shortcut is reserved by macOS.
5. Attempt to set a normal custom shortcut, such as `Cmd+Shift+Option+V`.
6. Confirm registration succeeds.
7. Confirm no claim is made that arbitrary cross-app conflicts are detectable.

#### Regression

1. Set a valid shortcut.
2. Change it to another valid shortcut.
3. Change it back to the original shortcut.
4. Restart the app.
5. Confirm the saved shortcut still works.
6. Confirm stale same-app registration handling has not regressed.

## Screenshots

Capture screenshots for PR/review evidence, not as committed product assets unless requested.

Required screenshots:

1. **Windows conflict warning**
   - Settings hotkey field showing an attempted conflicting shortcut.
   - Specific “already in use by another app” message visible.

2. **macOS reserved shortcut warning**
   - Settings hotkey field showing a known reserved shortcut such as `Cmd+Space`.
   - Specific “reserved by macOS” message visible.

3. **Successful valid shortcut**
   - Settings UI after saving a valid non-reserved shortcut.
   - No warning visible.

Screenshots must not include personal information, account emails, access tokens, unrelated app windows, or active document contents.

## Boundaries

### Always Do

- Preserve existing valid shortcut registration behavior.
- Preserve stale same-app registration recovery.
- Use platform-specific behavior only where the OS supports it.
- Keep user-facing copy accurate: warn/pick another, never override.
- Use existing styling tokens and Settings UI patterns.
- Run targeted verification before completing implementation.

### Ask First

- Adding new dependencies.
- Introducing new OS permissions.
- Changing the hotkey storage format.
- Adding telemetry or analytics.
- Expanding the macOS reserved shortcut list beyond common system shortcuts.
- Changing behavior for the fn/right-command event-tap path.

### Never Do

- Claim Verbatim can override another app’s hotkey.
- Claim macOS can reliably detect arbitrary cross-app hotkey conflicts.
- Scan other running apps to infer shortcut ownership.
- Add keylogging/event-tap behavior for generic detection.
- Swallow unknown registration errors as success.
- Persist or expose sensitive local environment details.

## Implementation Tasks

1. **Define structured hotkey errors**
   - Files: `src-tauri/src/commands/hotkey.rs`, related Tauri command type definitions if needed.
   - Acceptance: `set_hotkey` can return stable frontend-readable error codes.
   - Verify: Rust check/build passes.

2. **Classify Windows already-in-use failures**
   - Files: `src-tauri/src/commands/hotkey.rs`.
   - Acceptance: stale same-app registration remains tolerated; persistent “already registered” failures become `already_in_use`.
   - Verify: targeted Rust tests or manual Windows conflict test.

3. **Add macOS reserved shortcut detection**
   - Files: existing hotkey normalization utility or `src-tauri/src/commands/hotkey.rs`.
   - Acceptance: curated macOS reserved shortcuts are detected; normal shortcuts are not blocked.
   - Verify: unit tests for reserved and non-reserved examples.

4. **Update Settings UI messages**
   - Files: `src/routes/Settings.tsx`.
   - Acceptance: known error codes show specific messages; unknown failures keep the generic fallback.
   - Verify: frontend build and manual Settings flow.

5. **Document/manual verification evidence**
   - Files: PR description or issue automation output; screenshots as review artifacts if requested.
   - Acceptance: Windows conflict, macOS reserved warning, and valid shortcut success are demonstrated.
   - Verify: screenshots are redacted and contain no PII.

## Acceptance Criteria

- Windows shows a specific “already in use by another app” warning when registration fails because another process owns the shortcut.
- Windows does not present an override option.
- Existing stale same-app registration handling still works.
- macOS warns for the curated reserved shortcut list.
- macOS does not claim arbitrary cross-app conflict detection.
- Valid non-reserved shortcuts continue to save and trigger recording.
- Generic/unknown registration failures still surface as failures, not silent success.
- No new OS permissions are introduced.
- No app/process scanning is introduced.
- No shortcut data is sent to remote services.
- `pnpm build` passes.
- `pnpm lint` passes or any unrelated pre-existing lint failures are documented.
- `cd src-tauri && cargo check` passes if Rust changes are not otherwise covered by the build.

## Open Questions

None blocking.

The only expected review decision is the exact initial macOS reserved shortcut list. The implementation should keep it conservative and easy to adjust.
```

