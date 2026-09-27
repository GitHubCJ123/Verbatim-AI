# Spec

Proposed content for `docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/spec.md`:

```markdown
# Spec: Issue 0073 - Warn on Global Hotkey Conflicts Where Detectable

## Objective

Verbatim AI should give users clear feedback when a selected global recording hotkey cannot or should not be used.

The goal is not to override another app's shortcut. Operating systems do not provide a safe, supported way for Verbatim AI to take ownership of a shortcut already owned by another process. Instead, the app should:

1. On Windows, detect registration failure that indicates another app already owns the shortcut and tell the user to choose a different shortcut.
2. On macOS, warn for a curated list of well-known reserved or system shortcuts where reliable cross-app conflict detection is not available.
3. Preserve the existing stale same-app registration behavior so users are not blocked by Verbatim AI's own prior registration state.
4. Replace generic failure messaging with actionable user-facing copy where the failure reason is known.

Success means users understand whether their chosen shortcut is unavailable, reserved, or failed for an unknown reason, and can recover by selecting another shortcut.

## Assumptions

- Verbatim AI continues to use `tauri-plugin-global-shortcut` for normal global shortcut registration.
- Windows conflict detection is based on the plugin/global-hotkey registration error path, not a separate OS-wide hotkey scanner.
- macOS arbitrary cross-app shortcut conflict detection is out of scope because the platform API does not reliably expose it.
- The existing fn/right-command recording path on macOS uses a CGEventTap-style path and does not participate in normal global-hotkey registration conflict detection.
- The first implementation can use a small curated macOS reserved shortcut list and expand it later as users report cases.
- This feature is warning and recovery UX only; it must not attempt to override, unregister, intercept, or disable another application's shortcut.

## Current Repo Facts

- Verbatim AI is a Tauri 2 desktop app with:
  - Rust backend in `src-tauri/`
  - React/TypeScript frontend in `src/`
  - Main settings window and separate overlay recording window
- Global hotkeys are registered from the Rust command layer.
- Relevant files:
  - `src-tauri/src/commands/hotkey.rs`
    - Contains the `set_hotkey` command.
    - Registers shortcuts through the global shortcut plugin.
    - Currently handles a stale same-app `"already registered"` case by swallowing/recovering from that error.
  - `src/routes/Settings.tsx`
    - Contains frontend settings UI for changing the recording shortcut.
    - Currently shows a generic `"Couldn't register that shortcut"` style message for registration failure.
  - `src/lib/hotkey.ts`
    - Receives hotkey events emitted by Rust.
  - `src/lib/recording-bridge.ts`
    - Starts the recording flow after hotkey events.
- Dependency versions noted for this issue:
  - `tauri-plugin-global-shortcut 2.3.1`
  - `global-hotkey 0.7.0`
- Existing behavior:
  - No platform-specific conflict warning is shown.
  - Users receive generic failure feedback when registration fails.
  - The app attempts to work around stale registrations created by itself.

## Tech Stack

- Rust backend: Tauri 2 command layer
- Frontend: React + TypeScript
- State/UI: existing settings route and app store patterns
- Shortcut backend:
  - `tauri-plugin-global-shortcut`
  - `global-hotkey`
- Package manager: `pnpm`

## Commands

Use the existing project commands:

```bash
pnpm lint
pnpm build
pnpm tauri dev
```

For Rust-only validation, use the repo's existing Cargo/Tauri workflow rather than adding new tooling. If a targeted Rust test command already exists or is added by the implementation, prefer that before escalating to full app builds.

## Project Structure

```text
src-tauri/src/commands/hotkey.rs
  Rust command that registers, clears, and updates global shortcuts.

src/routes/Settings.tsx
  User-facing shortcut configuration UI and error display.

src/lib/
  Shared frontend utilities and Tauri command callers, if the implementation needs typed error handling helpers.

src-tauri/src/
  Rust-side tests or helper modules, if shortcut error classification is extracted.

docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/spec.md
  This implementation specification.
```

## Proposed Architecture

### 1. Rust error classification

Introduce explicit shortcut registration outcomes instead of returning only an opaque string error to the frontend.

Recommended shape:

```rust
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyRegistrationError {
    pub code: HotkeyRegistrationErrorCode,
    pub message: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyRegistrationErrorCode {
    AlreadyInUse,
    ReservedShortcut,
    InvalidShortcut,
    RegistrationFailed,
}
```

The exact type names can follow repo conventions, but the important part is a stable machine-readable `code`.

### 2. Preserve stale same-app recovery

The current `set_hotkey` implementation swallows a specific `"already registered"` error to handle stale same-app registration. That behavior should remain.

The implementation should distinguish:

- **Stale same-app registration**
  - Existing app state suggests Verbatim AI itself previously registered the same shortcut.
  - Recovery path may unregister/clear then retry as the current implementation does.
  - Do not show a conflict warning if retry succeeds.

- **Genuine registration failure**
  - After stale same-app recovery is exhausted or not applicable, registration still fails.
  - On Windows, classify likely `"already registered"` / `RegisterHotKey` conflict failures as `AlreadyInUse`.
  - For unknown failures, classify as `RegistrationFailed`.

Avoid relying on a single brittle exact error string if possible. Prefer a narrow helper that documents known plugin/global-hotkey messages and keeps matching centralized.

### 3. Windows behavior

When normal shortcut registration fails because the OS reports the key combination is already registered, return `AlreadyInUse`.

Frontend copy:

> That shortcut is already in use by another app. Choose a different shortcut.

Important constraints:

- Do not claim Verbatim AI can override the other app.
- Do not attempt to unregister or replace another app's shortcut.
- Do not continue saving the conflicting shortcut as active if registration failed.

### 4. macOS reserved-shortcut warnings

Add a curated reserved shortcut check for macOS before or during shortcut save.

Suggested initial blocklist:

| Shortcut | Reason |
|---|---|
| `Command+Space` | Spotlight |
| `Command+Option+Space` | Finder search / system search behavior |
| `Control+Command+Space` | Character Viewer |
| `Command+Tab` | App switcher |
| `Command+Shift+Tab` | Reverse app switcher |
| `Command+Option+Esc` | Force Quit |
| `Command+Comma` | Common app preferences convention; consider warning-only if not hard-blocked |
| `Command+Q` | Quit active app; consider warning-only if not hard-blocked |

Implementation should decide whether reserved shortcuts are:

1. **Blocked**: cannot be saved.
2. **Warned**: user can continue after acknowledgement.

For this issue, prefer **blocked for clearly system-owned shortcuts** and **warning-only only if the app already has an established confirmation UX**. If no confirmation UX exists, keep the initial implementation simple: reject clearly reserved shortcuts with actionable copy.

Frontend copy:

> That shortcut is reserved by macOS. Choose a different shortcut.

If a warning/confirmation UX is implemented:

> That shortcut may conflict with a macOS system shortcut. It may not work reliably.

### 5. Frontend error handling

Update the Settings shortcut-save flow to branch on structured error code.

Recommended mapping:

```ts
const hotkeyErrorMessage: Record<HotkeyRegistrationErrorCode, string> = {
  alreadyInUse: "That shortcut is already in use by another app. Choose a different shortcut.",
  reservedShortcut: "That shortcut is reserved by your operating system. Choose a different shortcut.",
  invalidShortcut: "That shortcut is not valid. Choose a different key combination.",
  registrationFailed: "Couldn't register that shortcut. Choose a different shortcut and try again.",
};
```

The exact implementation should reuse existing notification/toast/form-error patterns in `Settings.tsx`.

### 6. Shared shortcut normalization

Reserved shortcut matching should use the same normalized shortcut representation used by registration, not raw display text, so equivalent input orderings match consistently.

Example:

```ts
// Display order can vary, but matching should not.
normalizeShortcut(["Space", "Meta"]) === normalizeShortcut(["Meta", "Space"])
```

If normalization already exists, reuse it. If not, add the smallest helper needed close to existing hotkey parsing code.

## Code Style

Follow existing Rust and TypeScript conventions. Prefer small named helpers over inline string matching in UI code.

Example TypeScript style:

```ts
function getHotkeyRegistrationMessage(code: HotkeyRegistrationErrorCode): string {
  switch (code) {
    case "alreadyInUse":
      return "That shortcut is already in use by another app. Choose a different shortcut.";
    case "reservedShortcut":
      return "That shortcut is reserved by your operating system. Choose a different shortcut.";
    case "invalidShortcut":
      return "That shortcut is not valid. Choose a different key combination.";
    default:
      return "Couldn't register that shortcut. Choose a different shortcut and try again.";
  }
}
```

Example Rust style:

```rust
fn classify_hotkey_error(error: &str) -> HotkeyRegistrationErrorCode {
    if is_already_registered_error(error) {
        HotkeyRegistrationErrorCode::AlreadyInUse
    } else {
        HotkeyRegistrationErrorCode::RegistrationFailed
    }
}
```

Keep error classification centralized and covered by tests.

## Security and Privacy

- Do not log full app state, window titles, active app names, environment variables, or user profile data while handling shortcut errors.
- Do not persist raw backend error strings in localStorage or synced user settings.
- Do not expose OS-specific diagnostic details in user-facing messages unless they are actionable.
- Do not attempt to enumerate other applications' registered shortcuts.
- Do not attempt to override, unregister, or interfere with shortcuts owned by other applications.
- Treat shortcut strings as user-controlled input:
  - Validate before registration.
  - Avoid shell execution.
  - Avoid broad catch-and-ignore behavior that makes failures look successful.
- Preserve safe failure behavior: if registration fails, the app should not claim the shortcut is active.

## Testing Strategy

### Rust tests

Add focused tests for error classification and reserved shortcut detection where practical.

Coverage should include:

- Known Windows/plugin already-registered error text maps to `AlreadyInUse`.
- Unknown registration error maps to `RegistrationFailed`.
- Stale same-app registration recovery path still succeeds when unregister/retry succeeds.
- Stale same-app registration recovery does not hide a persistent genuine conflict.
- macOS reserved shortcut helper matches normalized forms such as:
  - `Command+Space`
  - `Space+Command`
  - platform alias forms if supported by existing parser

### TypeScript tests

If the repo has frontend tests for settings helpers, add/extend tests for:

- `alreadyInUse` displays the conflict-specific message.
- `reservedShortcut` displays the reserved shortcut message.
- unknown/legacy errors fall back to the generic failure message.
- failed registration does not update displayed/saved active shortcut as if successful.

If no frontend test harness exists for `Settings.tsx`, keep UI logic small and test any extracted pure helper.

### Manual QA

Test on Windows:

1. Register a common shortcut in another app.
2. Attempt to set the same shortcut in Verbatim AI.
3. Confirm Verbatim AI shows the already-in-use message.
4. Confirm the prior working Verbatim AI shortcut remains active or the UI clearly shows no new shortcut was saved.
5. Confirm choosing a different shortcut succeeds.

Test on macOS:

1. Attempt to set `Command+Space`.
2. Confirm Verbatim AI shows the reserved shortcut warning/error.
3. Attempt to set an ordinary shortcut.
4. Confirm it registers successfully.
5. Confirm fn/right-command recording behavior is unchanged if supported by the current app.

Regression test:

1. Set a shortcut.
2. Restart the app or trigger the stale same-app condition covered by existing logic.
3. Confirm the app still recovers from its own stale registration and does not show a false conflict warning.

## Screenshots

Capture screenshots after implementation for the PR or issue closure:

1. **Windows conflict**
   - Settings shortcut editor showing:
     - attempted conflicting shortcut
     - message: "That shortcut is already in use by another app. Choose a different shortcut."

2. **macOS reserved shortcut**
   - Settings shortcut editor showing:
     - attempted reserved shortcut, such as `Command+Space`
     - message: "That shortcut is reserved by your operating system. Choose a different shortcut."

3. **Successful shortcut**
   - Settings shortcut editor after choosing a non-conflicting shortcut with no error state.

Screenshots must not include personal information, account identifiers, email addresses, file paths, or unrelated desktop/window content.

## Boundaries

### Always do

- Preserve existing stale same-app hotkey recovery behavior.
- Use structured error codes between Rust and frontend where possible.
- Keep OS-specific behavior explicit and documented.
- Validate shortcut input before registration.
- Keep user-facing copy accurate: warn/pick another, not override.
- Run the smallest relevant tests/build checks before completion.

### Ask first

- Adding new dependencies.
- Replacing `tauri-plugin-global-shortcut`.
- Introducing a new modal confirmation UX if no comparable pattern exists.
- Changing persisted shortcut schema.
- Changing the fn/right-command CGEventTap behavior.
- Expanding scope to Linux or other platforms.

### Never do

- Do not attempt to override another application's shortcut.
- Do not unregister shortcuts owned by another app.
- Do not scan or enumerate other apps to infer their shortcuts.
- Do not persist raw OS/plugin errors in user settings.
- Do not log sensitive local context.
- Do not silently accept a shortcut after registration failed.

## Implementation Plan

1. Inspect existing hotkey registration flow.
   - Confirm current stale same-app recovery behavior.
   - Identify the exact frontend call path from `Settings.tsx` to the Tauri command.

2. Add backend error typing.
   - Define structured hotkey registration error code(s).
   - Centralize plugin error classification.
   - Preserve existing retry/recovery behavior.

3. Add macOS reserved shortcut detection.
   - Normalize shortcuts before matching.
   - Add a small curated reserved list.
   - Return `ReservedShortcut` for blocked reserved shortcuts.

4. Update frontend error handling.
   - Parse structured Tauri command errors.
   - Show specific messages for `AlreadyInUse` and `ReservedShortcut`.
   - Preserve generic fallback for unknown failures.

5. Add tests.
   - Backend helper tests for classification and reserved matching.
   - Frontend helper tests if a test harness exists or a pure helper is extracted.

6. Validate manually on target platforms where available.
   - Windows conflict path.
   - macOS reserved shortcut path.
   - Non-conflicting shortcut success path.
   - Stale same-app regression path.

## Acceptance Criteria

- On Windows, when the selected shortcut is already registered by another app and registration fails, Verbatim AI shows:
  - "That shortcut is already in use by another app. Choose a different shortcut."
- On Windows, Verbatim AI does not claim the conflicting shortcut was saved or active after registration failure.
- On Windows, stale same-app registration recovery still works as before when retry succeeds.
- On macOS, selecting a curated reserved shortcut such as `Command+Space` shows a reserved-shortcut warning/error.
- On macOS, arbitrary cross-app conflict detection is not claimed or implied.
- User-facing copy does not use "override" or suggest Verbatim AI can take over another app's shortcut.
- Unknown registration failures still show a safe generic error.
- Existing successful shortcut registration behavior is unchanged.
- Tests cover error classification and reserved shortcut matching.
- No sensitive diagnostic data is logged or persisted.

## Open Questions

- Should macOS reserved shortcuts be hard-blocked, or should users be allowed to continue after a warning?
- What exact shortcut string format does the current UI/backend use for persisted shortcuts?
- Does the repo currently have a frontend test harness suitable for `Settings.tsx`, or should UI message logic be extracted into a pure helper for testing?
- Which Windows error strings are emitted by `tauri-plugin-global-shortcut 2.3.1` / `global-hotkey 0.7.0` in practice for `RegisterHotKey` conflicts?
```
