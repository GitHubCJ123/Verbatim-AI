# Spec

Proposed content for `docs/automation/specs/issue-0053-fully-rust-first-push-to-talk-hot-path-start-cap/spec.md`:

```markdown
# Spec: Issue #53 - Fully Rust-first push-to-talk hot path

## Objective

Move the push-to-talk audio-start hot path fully into Rust so a key-down event begins native audio capture before any JavaScript or webview orchestration runs.

Today, the warm native capture engine removes most latency by keeping the microphone stream open, but the session start still flows through the webview:

```text
fn CGEventTap / global shortcut
  -> emit hotkey:down
  -> main-window JavaScript resolves mode and starts native session
  -> Rust native audio starts capturing
```

The target architecture is:

```text
fn CGEventTap / global shortcut
  -> Rust native audio starts capturing immediately
  -> emit hotkey:down with sessionId
  -> JavaScript adopts the already-started session
  -> stop path takes the native recording
```

Success means the first captured sample for native Fast mode is taken without JavaScript on the critical path, while preserving Standard/WebAudio behavior, overlay UX, live meter/partials, and non-macOS builds.

## Assumptions

1. This change applies only to native Fast capture paths; Standard/WebAudio must continue to use the existing JS/Web Audio flow.
2. The Rust warm capture engine from issue #51 is already present and is the source of truth for native capture sessions.
3. Fast/native capture is already the default from issue #52, so this should be shipped as the default behavior rather than hidden behind a new opt-in flag.
4. Mode resolution still belongs in JavaScript initially, but it must no longer block audio capture start.
5. The Rust hot path can use pre-armed capture configuration stored before key-down, then JavaScript can reconcile/adopt the resulting session after mode resolution.
6. macOS `fn` hotkey handling is the primary target, but the same native notification API should also be callable from the global shortcut path where applicable.

## Tech Stack

- Desktop shell: Tauri 2
- Native backend: Rust under `src-tauri/`
- Frontend: React + TypeScript under `src/`
- State: Zustand stores with localStorage cache keys prefixed `sw.`
- Overlay window: separate Vite/Tauri entrypoint at `overlay.html` and `src/overlay/`
- Native audio: Rust commands under `src-tauri/src/commands/native_audio.rs`
- Hotkeys:
  - `src-tauri/src/commands/fn_hotkey.rs`
  - `src-tauri/src/commands/hotkey.rs`
  - frontend listener bridge under `src/lib/hotkey.ts`
- Recording bridge:
  - `src/lib/recording-bridge.ts`
  - `src/overlay/Overlay.tsx`

## Commands

Use the existing project commands only.

```bash
pnpm install
pnpm build
pnpm lint
pnpm tauri build
pnpm tauri dev
```

For targeted Rust validation during implementation:

```bash
cd src-tauri && cargo check
cd src-tauri && cargo test
```

For frontend-only validation:

```bash
pnpm build
pnpm lint
```

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with two windows:

| Window | Purpose |
| --- | --- |
| `main` | Settings and management UI rendered by React Router in `src/App.tsx` |
| `overlay` | Transparent always-on-top recording pill/panel rendered from `overlay.html` and `src/overlay/` |

Current recording flow:

1. Rust emits `hotkey:down` / `hotkey:up`.
2. `src/lib/hotkey.ts` receives the events.
3. JavaScript calls `src/lib/modeResolver.ts` to inspect the active app via the `get_active_window` Tauri command.
4. `src/lib/recording-bridge.ts` shows the overlay and emits `recording:start`.
5. `src/overlay/Overlay.tsx` captures audio or coordinates native capture.
6. AI provider selection happens through `src/lib/ai/index.ts`.
7. Final text is pasted through the Rust `paste_to_target` command.

Relevant Rust command areas:

| File | Purpose |
| --- | --- |
| `src-tauri/src/commands/native_audio.rs` | Native warm audio capture engine and session commands |
| `src-tauri/src/commands/fn_hotkey.rs` | macOS `fn` CGEventTap handling |
| `src-tauri/src/commands/hotkey.rs` | Global shortcut handling |
| `src-tauri/src/commands/active_window.rs` | Foreground app/window lookup |
| `src-tauri/src/commands/paste.rs` | Paste final text into the target app |

## Architecture

### Native session ownership

Add a synchronous Rust-first notification API to the native audio engine:

```rust
pub enum PttNotifyResult {
    Started { session_id: String },
    Stopped { session_id: String },
    Ignored { reason: PttIgnoreReason },
}

pub fn notify_ptt_down(app: &AppHandle) -> Result<PttNotifyResult, NativeAudioError>;
pub fn notify_ptt_up(app: &AppHandle) -> Result<PttNotifyResult, NativeAudioError>;
```

The exact shape may vary, but the behavior should be:

- `notify_ptt_down` starts native capture synchronously if native Fast capture is armed and available.
- It returns the already-started `sessionId`.
- It is safe to call from both the `fn` tap callback path and the global shortcut handler.
- It must not perform blocking webview work, active-window lookup, network calls, model selection, or JS-dependent mode resolution.
- If native capture is not armed or not applicable, it returns an explicit ignored/not-applicable result so existing Standard/WebAudio behavior can continue.

### Arm-time configuration

Because the hot path must not wait for JavaScript, Rust needs enough configuration ahead of key-down.

Add or reuse an arm/update command that stores the current native capture hot-path config in Rust:

```rust
struct NativePttArmConfig {
    enabled: bool,
    pre_roll_ms: u32,
    expected_sample_rate: Option<u32>,
    expected_channels: Option<u16>,
    capture_mode: NativeCaptureMode,
}
```

The frontend should update this when relevant settings change, not at key-down time.

The hot path may use the most recently armed configuration. If the configuration is missing, stale, disabled, or incompatible, Rust should safely decline the Rust-first start and allow the existing JS path to proceed.

### Event contract

Change hotkey events so native-started sessions can be adopted by JavaScript.

Current conceptual event:

```ts
type HotkeyDownEvent = {
  // existing fields
}
```

Target conceptual event:

```ts
type HotkeyDownEvent = {
  sessionId?: string;
  nativeStarted?: boolean;
  startedAt?: number;
}
```

For `hotkey:up`:

```ts
type HotkeyUpEvent = {
  sessionId?: string;
  nativeStopped?: boolean;
  stoppedAt?: number;
}
```

Rules:

- Rust calls `notify_ptt_down` before emitting `hotkey:down`.
- If Rust starts native capture, it includes `sessionId` and `nativeStarted: true`.
- JavaScript must adopt the session instead of calling `start_native_session` again.
- Rust calls `notify_ptt_up` before or during the key-up handling path where this is safe and consistent.
- JavaScript stop handling should call `take_native_recording(sessionId)` for adopted native sessions.
- If no native session was started, event payloads remain backward-compatible and existing JS behavior continues.

### JavaScript adoption flow

Update the JS recording bridge so the key-down path separates UI/mode work from audio start.

Target flow:

```text
hotkey:down { sessionId, nativeStarted }
  -> capture target window if needed
  -> show overlay immediately
  -> resolve mode asynchronously
  -> if nativeStarted: overlay adopts sessionId
  -> else: existing WebAudio/native start path
```

The overlay should distinguish:

```ts
type RecordingStartSource =
  | { kind: "native-adopt"; sessionId: string }
  | { kind: "native-js-start" }
  | { kind: "web-audio" };
```

This prevents double-starting while preserving existing flows.

### Stop flow

On key-up:

```text
Rust notify_ptt_up
  -> emit hotkey:up { sessionId }
  -> JS tells overlay to stop
  -> overlay calls take_native_recording(sessionId)
  -> cleanup/transcription/paste flow continues
```

If Rust already finalized or marked the session stopped, `take_native_recording` should consume the buffered recording by `sessionId`.

### Decoupling active-window and mode resolution

`get_active_window` and mode resolution should no longer block native audio capture start.

Mode resolution can still happen after key-down for:

- selecting transcription/cleanup provider settings
- applying vocabulary/mode prompts
- display labels
- app-specific behavior
- final paste behavior

If mode resolution determines that native capture should not have been used, the implementation should choose a safe behavior explicitly. Preferred behavior:

1. Capture immediately in native Fast mode using armed defaults.
2. Resolve mode.
3. Apply mode-specific transcription/cleanup settings to the already-captured audio.
4. Do not discard captured audio solely because mode resolution completed after capture start.

### Engine nit N4: pre-size long recording buffers

The realtime cpal callback should avoid amortized `Vec` growth during long recordings.

Implementation direction:

- Pre-size session buffers at session creation.
- Capacity should cover at least pre-roll plus a reasonable initial recording window.
- Avoid unbounded up-front allocation.
- Growth beyond the initial capacity is acceptable outside the common short-recording path, but the realtime callback should minimize allocation pressure.
- Prefer existing config/constants if present.

Conceptual Rust shape:

```rust
let initial_frames = sample_rate as usize * initial_seconds * channels as usize;
let pre_roll_frames = pre_roll_frame_count * channels as usize;
let capacity = initial_frames.saturating_add(pre_roll_frames);

let samples = Vec::with_capacity(capacity);
```

### Engine nit S2: mid-session device-loss event

When native audio capture fails mid-session due to device loss or stream failure, Rust should emit a structured event:

```ts
type NativeAudioErrorEvent = {
  sessionId?: string;
  code: "device_lost" | "stream_error" | "capture_failed";
  message: string;
  recoverable: boolean;
}
```

Event name:

```text
native_audio:error
```

Rules:

- Include `sessionId` when the failure is associated with a session.
- Do not include secrets, local filesystem paths, raw provider payloads, or unnecessary device identifiers.
- The overlay should surface a user-actionable error state.
- Existing fallback/recovery behavior should remain explicit; do not silently return success-shaped empty audio.

## Security and Privacy

### Hot-path safety

The Rust hot path must not:

- block on JavaScript
- perform network requests
- inspect untrusted webview state
- parse user-controlled regular expressions
- perform active-window mode matching
- acquire locks in an order that risks deadlock with audio callbacks
- allocate heavily inside the realtime cpal callback

### Error-event safety

`native_audio:error` payloads must be sanitized:

- Include stable error codes and short messages.
- Include `sessionId` only when needed for correlation.
- Do not expose absolute paths, device unique IDs, environment variables, provider keys, transcripts, or raw audio data.
- Avoid verbose debug dumps.

### Concurrency safety

The native engine should define clear behavior for repeated or overlapping events:

| Scenario | Expected behavior |
| --- | --- |
| duplicate key-down while session active | return/adopt existing active session or explicitly ignore |
| key-up without active session | no crash; existing JS fallback remains safe |
| JS attempts `start_native_session` after native-started session | prevented by adoption state |
| device lost during active session | emit `native_audio:error` with `sessionId`; overlay exits recording state |
| warm engine unavailable | no native start; Standard/WebAudio path remains available |

### Platform safety

- macOS `fn` tap changes must be gated with existing platform-specific compilation.
- Windows and non-macOS builds must compile without requiring macOS-only APIs.
- Global shortcut changes must preserve existing behavior on supported platforms.

## Code Style

Follow existing Rust and TypeScript conventions. Prefer explicit result types and typed event payloads over broad catch-all behavior.

Example TypeScript event handling style:

```ts
type HotkeyDownPayload = {
  sessionId?: string;
  nativeStarted?: boolean;
  startedAt?: number;
};

function getNativeAdoptSource(payload: HotkeyDownPayload) {
  if (!payload.nativeStarted || !payload.sessionId) {
    return null;
  }

  return {
    kind: "native-adopt" as const,
    sessionId: payload.sessionId,
  };
}
```

Example Rust style:

```rust
match native_audio::notify_ptt_down(&app_handle) {
    Ok(PttNotifyResult::Started { session_id }) => {
        emit_hotkey_down(&app_handle, Some(session_id), true)?;
    }
    Ok(PttNotifyResult::Ignored { .. }) => {
        emit_hotkey_down(&app_handle, None, false)?;
    }
    Err(error) => {
        emit_native_audio_error(&app_handle, error.session_id(), &error)?;
        emit_hotkey_down(&app_handle, None, false)?;
    }
}
```

Key conventions:

- Do not use broad silent fallbacks.
- Do not add `as any` or equivalent type escapes in TypeScript.
- Keep event payloads backward-compatible.
- Use existing Tauri emit/listen patterns.
- Reuse existing session ID generation and native audio helpers where present.
- Keep platform-specific Rust behind existing `cfg` boundaries.

## Testing Strategy

### Rust tests

Add or update Rust tests around native audio session state where the code is testable without real microphone hardware.

Coverage targets:

- `notify_ptt_down` starts a session when armed.
- `notify_ptt_down` returns ignored/not-applicable when native capture is disabled.
- duplicate down events do not create double sessions.
- `notify_ptt_up` handles active and missing sessions safely.
- session buffers are initialized with expected capacity.
- mid-session stream/device errors emit or enqueue a sanitized `native_audio:error`.

Commands:

```bash
cd src-tauri && cargo test
cd src-tauri && cargo check
```

### TypeScript tests

Add or update tests for the frontend hotkey/recording bridge if the repo has existing test infrastructure for these modules.

Coverage targets:

- `hotkey:down` with `nativeStarted/sessionId` adopts an existing native session.
- adopted sessions do not call `start_native_session`.
- non-native or missing-session events preserve existing behavior.
- key-up calls `take_native_recording(sessionId)` for adopted sessions.
- native audio errors put the overlay into an error-visible state.

Validation commands:

```bash
pnpm build
pnpm lint
```

### Manual validation

Manual validation should cover:

1. macOS Fast mode:
   - press `fn`
   - native session starts before JS orchestration
   - overlay appears
   - meter/live partials still work
   - key-up produces transcription and paste

2. macOS fallback:
   - native Fast unavailable or disabled
   - Standard/WebAudio still records

3. non-macOS:
   - project builds
   - no macOS-only symbols leak into shared code

4. error behavior:
   - simulated or forced native stream failure emits `native_audio:error`
   - overlay shows a useful error
   - app does not paste empty/success-shaped output

## Screenshots and Observability

No new permanent UI is required, but implementation evidence should include screenshots or short captures for any visible UI changes.

Recommended artifacts:

| Artifact | Purpose |
| --- | --- |
| overlay during adopted native session | confirms existing recording UI still appears |
| overlay error state for `native_audio:error` | confirms S2 is user-visible |
| logs or trace output showing event order | confirms Rust start precedes JS adoption |

Suggested event-order trace for development only:

```text
native_audio notify_ptt_down started session=<id>
emit hotkey:down nativeStarted=true session=<id>
js adopted native session=<id>
native_audio notify_ptt_up stopped session=<id>
js take_native_recording session=<id>
```

Development traces must not include transcripts, raw audio, secrets, absolute paths, or device identifiers.

## Boundaries

### Always do

- Preserve Standard/WebAudio behavior.
- Preserve Windows and non-macOS builds.
- Keep macOS-specific hotkey code behind platform gates.
- Include `sessionId` in native-started event payloads.
- Prevent double-starting native sessions from JavaScript.
- Surface mid-session native audio failures explicitly.
- Keep realtime audio callbacks allocation-light and non-blocking.
- Validate with Rust and frontend build/lint commands.

### Ask first

- Adding new dependencies.
- Changing provider selection semantics.
- Changing the public user-facing hotkey settings model.
- Removing existing fallback capture paths.
- Adding persistent telemetry or logging.
- Changing database/Supabase schema.
- Changing CI configuration.

### Never do

- Commit secrets or provider keys.
- Include raw audio, transcripts, absolute paths, or device identifiers in error events.
- Block the cpal audio callback on locks, webview calls, network calls, or filesystem I/O.
- Make JavaScript required for the first captured sample in native Fast mode.
- Break Standard/WebAudio as a fallback.
- Use silent success-shaped fallbacks for failed native capture.

## Implementation Plan

### Phase 1: Native engine API

Files likely touched:

- `src-tauri/src/commands/native_audio.rs`

Tasks:

- Add `notify_ptt_down` / `notify_ptt_up` API.
- Store/reuse arm-time native PTT configuration.
- Return structured results containing `sessionId` when capture starts.
- Ensure duplicate key-downs cannot double-start sessions.
- Pre-size native session buffers for expected recording capacity.

Acceptance:

- Native capture can start synchronously from Rust without JS.
- Session ID is available immediately.
- Buffer capacity is initialized before the realtime callback appends samples.

### Phase 2: Hotkey wiring

Files likely touched:

- `src-tauri/src/commands/fn_hotkey.rs`
- `src-tauri/src/commands/hotkey.rs`
- any shared hotkey event payload module/helper if present

Tasks:

- Call `notify_ptt_down` before emitting `hotkey:down`.
- Call `notify_ptt_up` on key-up where appropriate.
- Include `sessionId` and `nativeStarted/nativeStopped` in emitted events.
- Preserve existing event compatibility when native start is ignored/unavailable.

Acceptance:

- macOS `fn` press starts native capture before webview event handling.
- Global shortcut path uses the same native notification API where applicable.
- Existing listeners remain compatible with missing optional fields.

### Phase 3: Frontend adoption flow

Files likely touched:

- `src/lib/hotkey.ts`
- `src/lib/recording-bridge.ts`
- `src/overlay/Overlay.tsx`
- related recording types/store files if present

Tasks:

- Add typed hotkey payload support for optional native session fields.
- Add native-adopt recording source/state.
- Prevent `start_native_session` when `sessionId` is already provided.
- Keep overlay display and mode resolution behavior intact.
- Ensure stop path calls `take_native_recording(sessionId)`.

Acceptance:

- JS adopts native-started sessions.
- No double-start occurs.
- Overlay meter/live partial behavior is preserved.
- Mode resolution no longer blocks audio capture start.

### Phase 4: Native audio error event

Files likely touched:

- `src-tauri/src/commands/native_audio.rs`
- `src/overlay/Overlay.tsx`
- possibly shared event type files

Tasks:

- Emit `native_audio:error` on mid-session device loss or stream failure.
- Include sanitized `sessionId`, code, message, and recoverability.
- Show an overlay error state.
- Ensure failures do not produce empty successful recordings.

Acceptance:

- Device-loss path is visible to the user.
- Error payload is sanitized.
- Recording state is cleaned up safely.

### Phase 5: Verification

Run:

```bash
cd src-tauri && cargo test
cd src-tauri && cargo check
pnpm build
pnpm lint
```

Manual checks:

- macOS `fn` Fast capture.
- Standard/WebAudio fallback.
- Non-macOS compile behavior where available.
- Overlay error state.

## Acceptance Criteria

1. Pressing `fn` in native Fast mode starts capture in Rust before any JavaScript receives or handles `hotkey:down`.
2. The `hotkey:down` event includes `sessionId` when Rust started the session.
3. JavaScript adopts native-started sessions and does not call `start_native_session` again for them.
4. Key-up stops or finalizes the same native session and JavaScript consumes it with `take_native_recording(sessionId)`.
5. `get_active_window` and mode resolution are no longer on the audio-start critical path.
6. Overlay meter and live partials still work for native Fast recordings.
7. Standard/WebAudio behavior is unchanged.
8. Windows and non-macOS builds are unaffected.
9. Native session buffers are pre-sized enough to avoid common-case realtime `Vec` growth during long recordings.
10. Mid-session device loss emits sanitized `native_audio:error` with `sessionId` when available.
11. Overlay surfaces native audio errors rather than silently producing successful empty output.
12. Existing build, lint, and test commands pass.

## Open Questions

1. What is the exact existing arm/config command surface for native Fast capture, and should this issue extend it or introduce a dedicated `arm_native_ptt` command?
2. Should `notify_ptt_up` actually stop capture synchronously in Rust before JS handles key-up, or should it only mark the native session as stopped while JS remains responsible for consuming it?
3. What initial buffer duration should be used for pre-sizing long recordings: fixed seconds, user-configurable maximum, or derived from existing app limits?
4. Should `native_audio:error` be emitted to both `main` and `overlay`, or only to the overlay window?
5. Are live partials currently derived from native audio during capture, or only after `take_native_recording`; if the former, adoption must preserve the partial-stream subscription path.
```
