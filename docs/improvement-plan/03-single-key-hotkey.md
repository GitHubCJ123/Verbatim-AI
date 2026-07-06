# 03 — Single-Key Hotkey (incl. macOS `fn`)

## Current state

- **TS side already supports single-key specs on macOS**:
  `src/lib/hotkey.ts` has `isSingleKeySpec` / `isMacSingleKeySpec` /
  `usesHoldToTalk` (single key ⇒ forced hold-to-talk), and
  `HotkeyRecorder.tsx` commits a modifier-less key when `IS_MAC`.
- **Rust side** (`src-tauri/src/commands/hotkey.rs`) parses the spec with
  `tauri_plugin_global_shortcut::Shortcut::from_str` and registers it.
  Single *regular* keys (e.g. `F13`, or even `A`) parse and register fine.
- **The gap:** `fn` is not a key the global-shortcut plugin can ever see.
  It's a hardware-level modifier; on macOS it surfaces only as a
  **flags-changed** event (`NSEvent.ModifierFlags.function` /
  `kCGEventFlagsChanged` with `maskSecondaryFn`). Same problem for using
  bare `⌘`/`⌥`/`⇧` as the trigger. No amount of spec parsing fixes this —
  it needs a native event tap.

## Design

### New Rust module: `src-tauri/src/commands/modifier_hotkey.rs` (macOS-only)

- A `CGEventTap` (via the `core-graphics` crate; listen-only,
  `kCGEventTapOptionListenOnly`) or `NSEvent.addGlobalMonitorForEvents`
  watching `flagsChanged`.
- Track the `fn` bit: transition 0→1 emits `hotkey:down`, 1→0 emits
  `hotkey:up` — **the same events the existing pipeline consumes**, so
  `src/lib/hotkey.ts` and everything downstream work unchanged.
- Spec sentinel: reserve the string `"Fn"` (and later `"RightCommand"` etc.).
  `set_hotkey` checks for sentinels first: sentinel → start/refresh the event
  tap and skip the global-shortcut plugin; otherwise current path. Only one
  mechanism active at a time (`clear_hotkey` tears down both).
- Guard key-repeat: flags-changed doesn't auto-repeat, but debounce identical
  consecutive states anyway.

### Permissions (the hard part)

A CGEventTap for keyboard events requires **Input Monitoring** (or the
NSEvent global monitor requires **Accessibility**). Flow:

1. Check `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)` /
   `AXIsProcessTrusted()`.
2. If missing, new command `request_input_monitoring` opens
   `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`
   and the UI shows a "grant, then click re-check" card (mirror the mic
   permission card pattern from onboarding).
3. `set_hotkey("Fn")` returns a typed error `"needs-input-monitoring"` so the
   frontend can branch.

### System conflict

macOS binds `fn` to emoji/dictation ("Press 🌐 to: …" in Keyboard settings).
We can't read that setting reliably; show a one-time notice when the user
picks `fn`: "If pressing fn opens the emoji picker, set System Settings →
Keyboard → 'Press 🌐 key to' → *Do Nothing*."

### Recorder UX (`src/components/settings/HotkeyRecorder.tsx`)

`fn` produces **no keydown** in the WebView, so it can't be "recorded".
Add explicit chips next to the recorder on macOS: `[fn]` `[Right ⌘]` —
click to select. Keep free recording for everything else. When a
single-key spec is active, show the existing forced-hold note
("single key = hold to talk") — logic already in `usesHoldToTalk`.

### Simplification opportunity while in here

`loadHotkeyConfig()` is re-read from localStorage on **every** down/up event
(`installHotkeyListeners`). Cache it in-module and invalidate from
`saveHotkeyConfig` — trivial, and removes a subtle inconsistency where a
mid-hold config change flips toggle/PTT behavior between down and up.

## Implementation steps

1. `modifier_hotkey.rs`: event tap thread + `hotkey:down/up` emission +
   start/stop API; wire sentinel branch into `set_hotkey`/`clear_hotkey`.
2. Permission check + `request_input_monitoring` command; typed error.
3. Recorder chips + permission card + conflict notice (frontend).
4. Persisted spec `"Fn"` must re-arm at boot: `installHotkeyListeners`
   already re-applies via `applyHotkey(cfg0.spec)` — verify the sentinel path
   is idempotent there.
5. Manual test matrix: fn hold/release; fn while another app fullscreen;
   permission revoked mid-session (tap dies — detect via
   `CGEventTapEnable` callback and surface "hotkey lost, re-grant" toast);
   switching fn → normal combo and back.

## Acceptance criteria

- On a MacBook, `fn` alone can be assigned; hold records, release stops.
- Regular combos keep working via the existing plugin path.
- Clear, recoverable UX when Input Monitoring is missing.
- Windows/Linux behavior completely unchanged (module is `#[cfg(target_os = "macos")]`).

## Risks

- Event taps get disabled by the OS under load (timeout) — handle
  `kCGEventTapDisabledByTimeout` by re-enabling.
- App Store distribution would need entitlement review (not a current target).
- `rdev` crate is an alternative to hand-rolled CGEventTap but brings its own
  event loop; hand-rolled keeps the dependency surface smaller.
