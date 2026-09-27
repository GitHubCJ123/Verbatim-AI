<!-- verbatim-ai:artifact:v1 issue=73 phase=spec id=issue-0073-issue-0073-85c212d3-9e14-4300-9c6b-532399d7e970-SPEC-006 display=SPEC-006 run=issue-0073-85c212d3-9e14-4300-9c6b-532399d7e970 -->
# SPEC-006: Architect spec

- Issue: #73
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0073-issue-0073-85c212d3-9e14-4300-9c6b-532399d7e970-SPEC-006
- Agent: architect
- Run: issue-0073-85c212d3-9e14-4300-9c6b-532399d7e970
- Created: 2026-07-25T03:22:32.281Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue 0073 - Warn on Global Hotkey Conflicts Where Detectable

## Objective

Verbatim AI should give users clearer feedback when their chosen global recording shortcut cannot or should not be used.

Today, users can choose a global hotkey in Settings, but the app does not distinguish between a generic registration failure, a shortcut already owned by another app on Windows, or a known reserved/system shortcut on macOS. This creates confusion because users may think Verbatim AI can “override” another app’s hotkey, which is not supported by the OS-level APIs.

Success means:

- On **Windows**, when global hotkey registration fails because the shortcut is already taken, the user sees a clear “already in use” message and is prompted to choose another shortcut.
- On **macOS**, the app warns for a curated list of well-known reserved/system shortcuts before or during save.
- The app does **not** claim it can override another app’s global hotkey.
- Existing same-app stale registration handling remains intact.

## Assumptions

1. The primary setting affected is the global recording hotkey configured in the Settings UI.
2. Windows conflict detection should rely on the existing `tauri-plugin-global-shortcut` / `global-hotkey` registration path rather than adding a new native dependency.
3. macOS arbitrary cross-app hotkey conflict detection is out of scope because the platform API does not reliably expose it.
4. The fn/right-command recording path on macOS is out of scope for conflict detection because it uses the CGEventTap path, not global hotkey registration.
5. The intended UX is “warn and choose another shortcut,” not “override.”

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript
- State: Zustand stores with `localStorage` cache
- Styling: CSS custom properties from `src/styles/tokens.css`
- Global shortcut plugin:
  - `tauri-plugin-global-shortcut 2.3.1`
  - `global-hotkey 0.7.0`

## Current Repo Facts

Relevant files and behaviors:

- `src-tauri/src/commands/hotkey.rs`
  - Contains `set_hotkey`.
  - Registers the configured shortcut through the Tauri global shortcut plugin.
  - Currently swallows an `"already registered"` error to recover from stale same-app registrations.
  - Other registration errors propagate generically.
- `src/routes/Settings.tsx`
  - Handles hotkey save UX.
  - Currently shows a generic failure message similar to “Couldn't register that shortcut.”
- `src/lib/hotkey.ts`
  - Receives `hotkey:down` and `hotkey:up` events.
- `src/lib/recording-bridge.ts`
  - Starts recording flow and overlay visibility.
- `src/overlay/Overlay.tsx`
  - Performs recording capture inside the overlay window.

This feature should stay focused on the Settings/global-hotkey configuration path and should not modify the recording pipeline except as necessary to preserve existing behavior.

## Architecture

### Backend Hotkey Registration

Add a typed error path around global hotkey registration.

The Rust command should distinguish these cases:

1. **Success**
   - Shortcut registers normally.
   - Settings save proceeds as today.

2. **Same-app stale registration**
   - Existing defensive behavior remains.
   - If the shortcut appears already registered by this app, unregister/re-register or otherwise preserve the current stale-state recovery.

3. **Windows conflict with another app**
   - When registration fails in a way consistent with the OS rejecting an already-registered hotkey, return a structured conflict error to the frontend.
   - Do not retry in a way that implies overriding another app.

4. **Other registration failure**
   - Return a structured generic registration error.

Recommended shape:

```rust
#[derive(Debug, serde::Serialize)]
#[serde(tag = "code", content = "details")]
pub enum HotkeyRegistrationError {
    AlreadyInUse,
    ReservedShortcut,
    InvalidShortcut(String),
    RegistrationFailed(String),
}
```

If the project already has an error type convention for Tauri commands, follow that pattern instead of introducing a parallel one.

### Frontend Settings UX

Update Settings hotkey save handling to map structured backend errors to specific copy.

Suggested messages:

| Case | User-facing message |
|---|---|
| Windows conflict | `That shortcut is already in use by another app. Choose a different shortcut.` |
| macOS reserved shortcut | `That shortcut is reserved by macOS. Choose a different shortcut.` |
| Invalid shortcut | `That shortcut is not supported. Choose a different shortcut.` |
| Unknown registration failure | `Couldn't register that shortcut. Choose a different shortcut and try again.` |

The UI should not mention “override.”

### macOS Reserved Shortcut Warning

Add a small curated reserved-shortcut list for macOS only.

Initial suggested blocklist:

| Shortcut | Reason |
|---|---|
| `Cmd+Space` | Spotlight |
| `Cmd+Option+Space` | Finder search / Spotlight-related system behavior |
| `Ctrl+Cmd+Space` | Emoji & Symbols |
| `Cmd+Tab` | App switcher |
| `Cmd+Shift+3` | Screenshot |
| `Cmd+Shift+4` | Screenshot region |
| `Cmd+Shift+5` | Screenshot toolbar |
| `Cmd+Q` | Quit active app |
| `Cmd+W` | Close window/tab |
| `Cmd+H` | Hide app |
| `Cmd+M` | Minimize window |

Implementation should normalize shortcut representation before comparison so equivalent display/order variants match the same reserved entry.

Recommended helper location:

- If hotkey parsing/normalization already exists, extend it.
- Otherwise add a small helper near the Settings hotkey logic, such as:
  - `src/lib/hotkeyReserved.ts`
  - or another existing hotkey utility file if present.

Example style:

```ts
export function getReservedHotkeyWarning(
  shortcut: string,
  platform: Platform,
): string | null {
  if (platform !== "macos") return null

  const normalized = normalizeHotkey(shortcut)
  return MACOS_RESERVED_HOTKEYS[normalized] ?? null
}
```

Use existing platform detection conventions in the app.

## Security and Privacy

- Do not enumerate other running apps to detect conflicts.
- Do not log the active foreground app, window title, or process list as part of hotkey registration failures.
- Do not expose raw native error strings directly to the user if they may include environment-specific details.
- Keep structured errors minimal and user-safe.
- Avoid broad catch-all fallbacks that silently persist a shortcut that failed to register.
- Do not add telemetry for chosen hotkeys unless an existing privacy-reviewed analytics pattern already exists.

## Testing Strategy

### Rust Tests

Add targeted tests where feasible for backend classification helpers:

- Same-app stale registration error remains recoverable.
- Windows “already registered” style failure maps to `AlreadyInUse`.
- Unknown registration failure maps to `RegistrationFailed`.

If the plugin error type is difficult to instantiate directly, extract string/error classification into a small pure helper and test that helper.

### TypeScript Tests

Add unit tests for reserved shortcut detection and normalization:

- `Cmd+Space` warns on macOS.
- `Command+Space` and reordered modifier variants normalize consistently.
- Reserved shortcuts do not warn on Windows.
- Non-reserved shortcuts do not warn.
- Existing valid user shortcuts remain accepted.

### Manual QA

Verify:

1. **Windows**
   - Register a shortcut already owned by another app.
   - Save in Verbatim AI.
   - Confirm the UI says it is already in use and asks for a different shortcut.
   - Confirm the previous working shortcut remains unchanged or the app clearly reflects that the new shortcut was not saved.

2. **macOS**
   - Try `Cmd+Space`.
   - Confirm the UI warns that it is reserved by macOS.
   - Try a normal shortcut such as `Ctrl+Option+Space`.
   - Confirm it can be saved if supported.

3. **Regression**
   - Save a normal shortcut.
   - Restart the app.
   - Confirm the shortcut still works.
   - Confirm recording flow still emits `hotkey:down` / `hotkey:up` and opens the overlay.

## Commands

Use the smallest relevant verification commands:

```bash
pnpm build
pnpm lint
```

If Rust tests are added:

```bash
cd src-tauri && cargo test hotkey
```

If frontend unit tests already exist and cover the touched files, run the relevant existing test command from `package.json`.

## Screenshots

Implementation PR should include screenshots or short screen recordings for:

1. Windows conflict error message in Settings.
2. macOS reserved shortcut warning in Settings.
3. Successful save of a valid shortcut after the warning/error state.

If screenshots are captured from a real desktop, redact any personal data visible in window titles, menu bars, filenames, account names, or desktop notifications.

## Boundaries

### Always do

- Preserve existing same-app stale registration recovery.
- Use platform-specific behavior: Windows conflict detection, macOS reserved list.
- Show clear user-facing copy that says the shortcut cannot be used.
- Keep the previous valid shortcut active if saving the new shortcut fails.
- Use existing styling tokens and Settings UI patterns.

### Ask first

- Adding a new native dependency.
- Changing the hotkey capture UX beyond warning/error messages.
- Introducing telemetry or analytics.
- Expanding this into process enumeration or per-app conflict detection.

### Never do

- Claim Verbatim AI can override another app’s global hotkey.
- Persist a shortcut after registration failed.
- Log or display sensitive system details from native errors.
- Treat arbitrary macOS cross-app conflicts as reliably detectable.
- Modify the recording pipeline unless required for regression safety.

## Acceptance Criteria

- Windows registration failures caused by an already-used shortcut produce a specific “already in use by another app” message.
- macOS reserved shortcuts from the curated list produce a specific reserved-shortcut warning.
- Generic failures still show a safe generic registration error.
- Existing valid hotkeys continue to register and trigger recording.
- Same-app stale registration handling is not broken.
- The implementation contains targeted tests for error classification and macOS reserved shortcut detection.
- Documentation/spec language and UI copy consistently describe the behavior as warning/pick-another, not override.

## Open Questions

1. Should macOS reserved shortcuts be blocked entirely, or should users be allowed to proceed after a warning?
2. What exact initial reserved-shortcut list should product approve for macOS?
3. Should the previous valid shortcut remain active automatically when saving a new shortcut fails? Recommended answer: yes.
```

