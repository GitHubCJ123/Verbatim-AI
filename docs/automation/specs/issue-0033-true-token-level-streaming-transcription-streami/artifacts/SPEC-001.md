<!-- verbatim-ai:artifact:v1 issue=33 phase=spec id=issue-0033-issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8-SPEC-001 display=SPEC-001 run=issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8 -->
# SPEC-001: Architect spec

- Issue: #33
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0033-issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8-SPEC-001
- Agent: architect
- Run: issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8
- Created: 2026-07-24T08:32:40.767Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue #33 - True Token-Level Streaming Transcription

## Objective

Implement a realistic, opt-in increment toward true token-level streaming transcription for Verbatim AI using a streaming-capable local transcription engine, without regressing the existing live-partial pseudo-streaming behavior.

Today’s live partial transcription is chunked pseudo-streaming: audio is captured in slices and sent to request/response engines such as `whisper-cli`, `whisper-server`, or existing local providers. This produces intermittent partial text but does not expose token-level updates from a continuously running decoder.

This feature should add a streaming-capable path that can emit incremental transcript tokens or short text deltas while recording is still active, then preserve the existing final transcription and cleanup pipeline.

Primary users are people dictating longer text who need immediate confidence that speech is being captured accurately before they release the hotkey.

## Assumptions

1. The first implementation should be **local-only** and should not change the Supabase/Azure cloud transcription path.
2. The feature should be **opt-in** behind a settings flag or provider selection because streaming engines may be heavier, less stable, or platform-specific.
3. Existing chunked live partials from issue #32 remain the default fallback.
4. “True token-level streaming” means the transcription engine emits incremental decoded text from an active audio stream, not repeated request/response transcription of completed chunks.
5. Cleanup remains non-streaming for this increment unless an existing cleanup provider already supports streaming safely.
6. A realistic increment may expose streaming partial transcription in the overlay while still using the existing final transcript flow for paste-to-target.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- Rust backend in `src-tauri/`
- React/TypeScript frontend in `src/`
- Main settings window rendered through `src/App.tsx`
- Transparent always-on-top overlay rendered from `overlay.html` and `src/overlay/`
- Recording orchestration through:
  - `src/lib/hotkey.ts`
  - `src/lib/modeResolver.ts`
  - `src/lib/recording-bridge.ts`
  - `src/overlay/Overlay.tsx`
  - `src/lib/audio.ts`
- AI provider abstraction in `src/lib/ai/AIProvider.ts`
- Provider selection/composition in `src/lib/ai/index.ts`
- Local transcription providers:
  - `src/lib/ai/localWhisper.ts`
  - `src/lib/ai/parakeet.ts`
- Local cleanup provider:
  - `src/lib/ai/ollama.ts`
- Rust local engine commands:
  - `src-tauri/src/commands/local_whisper.rs`
  - `src-tauri/src/commands/parakeet.rs`
- Text paste command:
  - `src-tauri/src/commands/paste.rs`
- Settings/state stored with Zustand under `src/lib/store/`
- Settings are mirrored to `localStorage` with `sw.` keys so the overlay can read synchronously.

The current local engines are request/response sidecars. They are suitable for final transcription and chunked partials, but not true decoder-level streaming unless a separate streaming sidecar or streaming API is introduced.

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript + Vite
- State: Zustand + `localStorage` cache
- Styling: CSS variables from `src/styles/tokens.css` and Tailwind mappings
- Local transcription sidecars:
  - Existing: `whisper-cli`
  - Existing: `sherpa-onnx` / Parakeet path
  - Candidate: `whisper.cpp` `whisper-stream`-style sidecar or streaming-capable ONNX path

## Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm tauri dev
pnpm tauri build
```

Targeted validation should prefer the smallest available command first:

```bash
pnpm build
pnpm lint
```

If Rust command changes are made:

```bash
pnpm tauri build
```

## Project Structure

```text
src/
  overlay/
    Overlay.tsx                         # Streaming partial UI lives here
  lib/
    audio.ts                            # Browser audio capture
    recording-bridge.ts                 # Main-to-overlay recording orchestration
    ai/
      AIProvider.ts                     # Provider contract extension point
      index.ts                          # Composite provider selection
      localWhisper.ts                   # Existing request/response Whisper provider
      parakeet.ts                       # Existing request/response Parakeet provider
      streamingTranscription.ts         # Proposed frontend streaming adapter/helpers
    store/
      profile.ts / related settings     # Opt-in streaming settings

src-tauri/
  src/
    commands/
      local_whisper.rs                  # Existing local Whisper sidecar management
      parakeet.rs                       # Existing Parakeet sidecar management
      streaming_transcription.rs        # Proposed streaming sidecar command module
    main.rs / lib.rs                    # Tauri command registration

docs/
  automation/
    specs/
      issue-0033-true-token-level-streaming-transcription-streami/
        spec.md                         # This spec
```

## Proposed Architecture

### High-Level Flow

```text
Hotkey down
  -> main window resolves mode
  -> overlay starts recording
  -> overlay captures microphone stream
  -> if streaming engine is enabled:
       start streaming sidecar session
       send audio frames to sidecar
       receive transcript deltas/events
       render partial text in overlay
     else:
       use existing chunked live partial behavior
  -> hotkey up
  -> stop stream/session
  -> produce final transcript
  -> run existing cleanup provider
  -> paste cleaned text into target window
```

### Provider Contract

Extend the local transcription abstraction without forcing all providers to support streaming.

Recommended shape:

```ts
export interface StreamingTranscriptionSession {
  pushAudio(frame: Float32Array | Blob): Promise<void>;
  finish(): Promise<TranscriptionResult>;
  cancel(): Promise<void>;
}

export interface StreamingTranscriptionEvents {
  onPartial(delta: TranscriptionDelta): void;
  onError(error: Error): void;
}

export interface TranscriptionDelta {
  text: string;
  fullText: string;
  isFinal?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
}
```

Existing providers continue implementing the current request/response interface. Streaming support should be detected capability-style:

```ts
if (provider.capabilities.streamingTranscription && settings.streamingEnabled) {
  // use streaming session
} else {
  // existing pseudo-streaming path
}
```

### Rust Sidecar Strategy

Implement one streaming backend first. Preferred order:

1. **Whisper.cpp streaming sidecar** if a practical `whisper-stream` binary can be bundled/downloaded consistently across supported platforms.
2. **Streaming ONNX/Parakeet path** if the existing sherpa-onnx sidecar exposes a stable streaming recognizer API or executable mode.
3. If neither is production-ready, implement the infrastructure and a guarded experimental backend with clear disabled-by-default UI messaging.

The Rust command layer should own:

- Sidecar discovery/download/version checks
- Process lifecycle
- Audio stream transport
- Event emission back to the overlay
- Cleanup on stop/cancel/error

Use Tauri events for partial transcript delivery rather than polling.

Example event names:

```text
streaming-transcription:partial
streaming-transcription:final
streaming-transcription:error
streaming-transcription:stopped
```

### Settings and Mode Behavior

Add an opt-in setting such as:

```ts
streamingTranscription: {
  enabled: boolean;
  engine: 'whisper-stream' | 'parakeet-stream';
}
```

Behavior:

- Default: disabled.
- If enabled but the streaming sidecar is unavailable, show a clear unavailable state and fall back to existing live partials.
- Per-mode overrides may be deferred unless current provider settings already support per-mode transcription overrides cleanly.
- The overlay should indicate streaming partials without changing the final paste UX.

### Overlay UX

The overlay should display low-latency partial text while recording. It should avoid visual churn by treating incoming deltas as an evolving full partial string rather than appending blindly.

States:

```text
Idle
Recording, no partial yet
Recording, streaming partial active
Recording, streaming unavailable fallback active
Finalizing
Error
```

Do not paste partial text. Only paste final cleaned text after the recording stops.

## Code Style

Follow existing TypeScript/Rust conventions and avoid provider-specific logic in overlay components.

Example frontend style:

```ts
const supportsStreaming =
  settings.streamingTranscription.enabled &&
  provider.capabilities.streamingTranscription === true;

const transcript = supportsStreaming
  ? await transcribeWithStreaming(provider, audioStream, {
      onPartial: setLivePartialText,
    })
  : await transcribeWithExistingLivePartials(provider, audioStream);
```

Key conventions:

- Keep provider capability checks explicit.
- Do not use broad `catch` blocks that silently fall back without user-visible status or logging consistent with repo patterns.
- Keep secrets and provider credentials out of logs.
- Use existing CSS tokens for overlay styling.
- Keep Tauri command payloads typed and narrow.

## Security and Privacy

### Audio and Transcript Privacy

- Do not send streaming audio to any new third-party service.
- Streaming sidecar must run locally unless a future spec explicitly covers cloud streaming.
- Do not persist raw microphone audio, partial transcripts, or final transcripts unless existing app behavior already does so.
- Do not log transcript contents by default.
- Error logs should include engine state and error codes, not dictated content.

### Sidecar Safety

- Sidecar binaries must be pinned by version and verified consistently with existing local engine download patterns.
- Do not execute arbitrary user-provided binary paths unless an existing advanced setting already supports this safely.
- Validate sidecar paths and arguments on the Rust side.
- Avoid shell invocation when spawning sidecars; use direct process execution with explicit args.
- Ensure child processes are terminated on recording stop, cancellation, overlay close, and app shutdown.

### Input Validation

- Validate audio frame size, sample rate, and session IDs.
- Reject events for unknown or closed streaming sessions.
- Ensure stale partial events from an old session cannot update a new recording session.

### Failure Handling

Failure must be explicit and non-regressive:

- If streaming startup fails, fall back to existing live partial behavior.
- If streaming fails mid-recording, stop the streaming session, show a non-blocking overlay status, and continue to final transcription through the existing stable path if audio is still available.
- If final transcription fails, preserve current error behavior.

## Testing Strategy

### Unit Tests

Add or update tests for:

- Provider capability detection.
- Streaming enabled/disabled selection.
- Fallback when streaming sidecar is unavailable.
- Ignoring stale streaming events by session ID.
- Partial text reducer behavior:
  - replaces full partial text correctly
  - handles token deltas correctly if supported
  - does not duplicate text
  - clears state between recordings

### Integration Tests

Add or update tests around:

- Overlay receiving streaming partial events.
- Recording stop finalizes the session once.
- Cancellation terminates the sidecar session.
- Existing request/response providers still work when streaming is disabled.

### Rust Tests

Where practical, test:

- Sidecar command argument construction.
- Session lifecycle state machine.
- Invalid session ID handling.
- Process cleanup paths.

### Manual QA

Manual QA should cover:

1. Streaming disabled: existing live partial behavior is unchanged.
2. Streaming enabled with sidecar installed: overlay updates continuously while speaking.
3. Streaming enabled with sidecar missing: app falls back cleanly.
4. Long recording: memory/process usage remains stable.
5. Cancel/interrupt recording: sidecar process exits.
6. Multiple back-to-back recordings: no stale transcript appears.
7. Final paste: only final cleaned text is pasted.

## Screenshots / Visual Evidence

Implementation PR should include screenshots or short screen recordings for:

1. Settings screen showing the opt-in streaming transcription control.
2. Overlay while recording with streaming partial text visible.
3. Fallback/unavailable state when the streaming engine cannot start.
4. Final pasted result in a target text field.

Screenshots must not contain personal data, private dictated content, credentials, emails, names, or sensitive app/window titles. Use synthetic text such as:

```text
This is a test of streaming transcription in Verbatim AI.
```

## Implementation Plan

### Phase 1: Feasibility Spike

Determine which local streaming engine is viable:

- Check whether `whisper.cpp` streaming binary can be bundled or downloaded using existing sidecar patterns.
- Check whether the existing Parakeet/sherpa-onnx path exposes streaming recognition.
- Choose one backend for the first increment.
- Document unsupported platforms or model limitations.

Deliverable: a short decision inside this spec or adjacent implementation notes.

### Phase 2: Streaming Session Infrastructure

Implement generic session plumbing:

- Rust session lifecycle.
- Tauri events for partial/final/error.
- Frontend event subscription.
- Session ID validation.
- Cleanup on stop/cancel.

Acceptance: a mocked or no-op streaming backend can emit partial events to the overlay without affecting existing transcription.

### Phase 3: Engine Integration

Integrate the selected streaming engine:

- Sidecar install/discovery.
- Process spawn.
- Audio input transport.
- Transcript event parsing.
- Final transcript extraction.
- Error propagation.

Acceptance: local streaming partial text appears while recording.

### Phase 4: Settings and Fallback

Add opt-in controls and fallback behavior:

- Disabled by default.
- Enable selected streaming engine.
- Show unavailable/fallback status.
- Preserve existing pseudo-streaming path.

Acceptance: users can enable/disable streaming without changing unrelated provider settings.

### Phase 5: Verification and Polish

- Add targeted tests.
- Verify process cleanup.
- Verify overlay UX.
- Capture screenshots or short recordings for PR evidence.

## Task Breakdown

- [ ] Task: Select the streaming backend
  - Acceptance: One backend is chosen with rationale and known limitations.
  - Verify: Documented feasibility decision.
  - Files: `docs/automation/specs/.../spec.md` or implementation notes.

- [ ] Task: Add streaming provider capability model
  - Acceptance: Existing providers compile unchanged or explicitly report no streaming capability.
  - Verify: `pnpm build`.
  - Files: `src/lib/ai/AIProvider.ts`, `src/lib/ai/index.ts`.

- [ ] Task: Add frontend streaming session adapter
  - Acceptance: Overlay can subscribe to partial/final/error events by session ID.
  - Verify: targeted unit tests if available, then `pnpm build`.
  - Files: `src/lib/ai/streamingTranscription.ts`, `src/overlay/Overlay.tsx`.

- [ ] Task: Add Rust streaming command module
  - Acceptance: Start/stop/cancel lifecycle exists and rejects invalid session IDs.
  - Verify: Rust build through `pnpm tauri build` or narrower available Rust check.
  - Files: `src-tauri/src/commands/streaming_transcription.rs`, command registration file.

- [ ] Task: Integrate selected streaming sidecar
  - Acceptance: Real partial transcript events are emitted during recording.
  - Verify: manual recording test.
  - Files: Rust command module plus sidecar management helpers.

- [ ] Task: Add settings UI
  - Acceptance: Streaming can be enabled/disabled and unavailable state is visible.
  - Verify: `pnpm build`, manual UI check.
  - Files: relevant settings components and store files.

- [ ] Task: Add fallback behavior
  - Acceptance: Existing pseudo-streaming runs when streaming is disabled or unavailable.
  - Verify: manual recording test with streaming disabled and with sidecar unavailable.
  - Files: provider selection and overlay recording flow.

- [ ] Task: Add tests
  - Acceptance: Capability selection, stale event handling, fallback, and partial reducer behavior are covered.
  - Verify: available targeted test command plus `pnpm build`.
  - Files: colocated test files following repo conventions.

## Boundaries

### Always Do

- Preserve existing transcription behavior when streaming is disabled.
- Keep streaming opt-in for this increment.
- Validate session IDs on every streaming event.
- Terminate sidecar processes on stop, cancel, error, and app shutdown.
- Avoid logging transcript contents or raw audio.
- Use existing styling tokens and state patterns.
- Run existing build/lint validation before merging.

### Ask First

- Adding a new external dependency or large sidecar binary.
- Changing database schema or Supabase functions.
- Making streaming the default.
- Sending streaming audio to a cloud service.
- Removing existing local transcription providers.
- Changing global hotkey behavior.
- Changing paste behavior.

### Never Do

- Commit secrets or provider keys.
- Log dictated content by default.
- Persist raw microphone audio without an explicit product decision.
- Execute arbitrary sidecar paths through a shell.
- Break existing request/response transcription providers.
- Paste partial streaming text into the target app.

## Acceptance Criteria

1. Streaming transcription is disabled by default.
2. When enabled and the selected streaming engine is available, the overlay displays incremental transcript text while recording is active.
3. Partial text comes from a streaming-capable engine/session, not repeated request/response transcription of completed chunks.
4. Releasing the hotkey still produces one final transcript, runs the existing cleanup path, and pastes only final cleaned text.
5. Existing pseudo-streaming behavior remains available and unchanged when streaming is disabled.
6. If the streaming engine is unavailable or fails to start, the app falls back to the existing non-streaming path with a clear non-blocking status.
7. Stale events from previous sessions cannot update the current overlay.
8. Sidecar processes are cleaned up after stop, cancel, error, and app shutdown.
9. No raw audio or transcript text is logged or persisted by the new streaming path.
10. Build and lint pass with the existing project commands.
11. PR evidence includes screenshots or short recordings of enabled streaming, disabled/fallback behavior, and final paste behavior using synthetic non-PII text.

## Open Questions

1. Which streaming backend is the best first target: `whisper.cpp` streaming sidecar or a streaming sherpa-onnx/Parakeet path?
2. Should the opt-in setting be global only, or should modes be able to override it?
3. What platforms must the first increment support: macOS only, or macOS + Windows?
4. Should partial text display raw transcription only, or eventually support streaming cleanup as a separate future feature?
5. Should the app expose model/latency settings for the streaming backend, or keep the first increment minimal?
```

