<!-- verbatim-ai:artifact:v1 issue=40 phase=spec id=issue-0040-issue-0040-3a8f2910-80fc-4e56-be8a-dcbe22cb9f7b-SPEC-007 display=SPEC-007 run=issue-0040-3a8f2910-80fc-4e56-be8a-dcbe22cb9f7b -->
# SPEC-007: Architect spec

- Issue: #40
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0040-issue-0040-3a8f2910-80fc-4e56-be8a-dcbe22cb9f7b-SPEC-007
- Agent: architect
- Run: issue-0040-3a8f2910-80fc-4e56-be8a-dcbe22cb9f7b
- Created: 2026-07-25T08:43:38.404Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue 0040 - Full Multi-Architecture Model Catalogue

## Objective

Add an opt-in multi-architecture model catalogue path for Verbatim AI that can support Handy-parity ASR model breadth through sidecar-based GGUF or equivalent runtime engines, without reintroducing in-process `whisper.cpp`/GGUF linking risk.

This spec designs the architecture for supporting additional ASR model families such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and future catalogue entries. Whisper and Parakeet must remain the default, stable engines.

Success means Verbatim can describe, discover, install, and invoke models across multiple ASR architectures through a data-driven catalogue while keeping runtime execution isolated in downloaded sidecar binaries.

## Assumptions

1. Verbatim must not link `whisper.cpp`, GGUF loaders, or transcribe-cpp style libraries in-process from Rust.
2. New model breadth should be opt-in and non-regressive.
3. The existing catalogue abstraction from issue #31 is already data-driven and can be extended rather than replaced.
4. GGUF architecture detection should come from GGUF metadata when available.
5. Sidecar engines should follow the existing local Whisper / Parakeet download-and-run pattern.
6. Initial implementation may support a narrow pilot architecture set, but the catalogue schema must support the broader model families.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- React/TypeScript frontend in `src/`
- Rust backend in `src-tauri/`
- Main settings window and separate transparent overlay window
- Zustand stores under `src/lib/store/`
- AI provider abstraction in `src/lib/ai/AIProvider.ts`
- Provider selection through `src/lib/ai/index.ts`
- Existing local ASR engines:
  - `LocalWhisperProvider` in `src/lib/ai/localWhisper.ts`
  - `ParakeetProvider` in `src/lib/ai/parakeet.ts`
  - `OllamaProvider` for cleanup only
- Existing Rust sidecar command areas:
  - `src-tauri/src/commands/local_whisper.rs`
  - `src-tauri/src/commands/parakeet.rs`
- Existing app modes:
  - local mode uses localStorage
  - cloud mode uses Supabase auth and sync

The recording pipeline is:

1. Rust hotkey emits `hotkey:down` / `hotkey:up`.
2. `src/lib/hotkey.ts` and `src/lib/modeResolver.ts` resolve the active mode.
3. `src/lib/recording-bridge.ts` emits recording lifecycle events to the overlay.
4. `src/overlay/Overlay.tsx` captures microphone audio.
5. `src/lib/ai/index.ts` resolves the active provider.
6. Text is pasted using Rust command `paste_to_target`.

## Proposed Architecture

### Runtime Strategy

Introduce a new sidecar-backed multi-architecture ASR engine layer.

The preferred runtime shape is:

```text
React/Zustand catalogue UI
        |
src/lib/ai provider abstraction
        |
Tauri command boundary
        |
Rust sidecar manager
        |
Downloaded prebuilt ASR sidecar
        |
Model files / GGUF metadata
```

No ASR architecture loader should run inside the Verbatim Rust process. The Rust app may manage sidecar lifecycle, file paths, process IO, health checks, and structured command responses.

### Engine Options

Support the architecture behind a generic engine abstraction so Verbatim can evaluate either path:

| Candidate | Role | Notes |
|---|---|---|
| GGUF multi-architecture sidecar | Preferred breadth path | transcribe-cpp-style loader; auto-detects architecture from GGUF metadata |
| sherpa-onnx per-architecture runtimes | Fallback or complementary path | useful where ONNX model quality, portability, or binary availability is better |

The implementation should not hard-code all future model families into provider logic. Instead, providers should consume catalogue metadata.

### Catalogue Schema Extensions

Extend the data-driven catalogue with fields similar to:

```ts
type ModelArchitecture =
  | "whisper"
  | "parakeet"
  | "canary"
  | "voxtral"
  | "qwen3-asr"
  | "moonshine"
  | "gigaam"
  | "granite"
  | "sensevoice"
  | "unknown";

type ModelRuntime = "whisper-ggml" | "parakeet-onnx" | "multiarch-gguf" | "sherpa-onnx";

type ModelCapabilities = {
  languages?: string[];
  supportsStreaming?: boolean;
  supportsTranslation?: boolean;
  supportsLanguageDetection?: boolean;
  supportsTimestamps?: boolean;
  sampleRates?: number[];
};

type CatalogueModel = {
  id: string;
  displayName: string;
  architecture: ModelArchitecture;
  runtime: ModelRuntime;
  format: "ggml" | "gguf" | "onnx";
  sizeBytes?: number;
  quantization?: string;
  downloadUrl?: string;
  checksumSha256?: string;
  capabilities: ModelCapabilities;
  metadataProbe?: {
    source: "static-catalogue" | "gguf-header" | "sidecar-probe";
    probedAt?: string;
  };
};
```

### Capability Probing

Capability probing should be layered:

1. Static catalogue metadata for known bundled or curated models.
2. GGUF header metadata probe for bring-your-own GGUF files.
3. Sidecar probe command for runtime-specific capabilities.
4. Conservative fallback when metadata is missing.

Missing capability data must not be treated as proof of support.

### Provider Integration

Add a new provider path, for example:

```ts
class MultiArchitectureProvider implements AIProvider {
  async transcribe(audio: Blob, options: TranscriptionOptions): Promise<TranscriptionResult> {
    // Resolve model runtime from catalogue metadata.
    // Invoke Tauri command.
    // Surface structured errors.
  }
}
```

`getActiveProvider(mode?)` should continue returning a composite provider where transcription and cleanup are independently selected.

Whisper and Parakeet remain defaults. Multi-architecture models are only used when explicitly selected globally or per mode.

### Rust Command Layer

Add Rust commands for sidecar-managed multi-architecture transcription, for example:

```rust
#[tauri::command]
async fn multiarch_probe_model(path: String) -> Result<ModelProbeResult, CommandError>;

#[tauri::command]
async fn multiarch_transcribe(req: MultiArchTranscribeRequest) -> Result<TranscriptionResult, CommandError>;

#[tauri::command]
async fn multiarch_runtime_status() -> Result<RuntimeStatus, CommandError>;
```

Rust responsibilities:

- Validate model paths.
- Prevent path traversal outside approved model directories unless explicitly handling user-selected local files.
- Verify checksums for managed downloads.
- Start sidecar processes with explicit arguments only.
- Avoid shell interpolation.
- Capture stdout/stderr safely.
- Return typed errors to the frontend.
- Keep process lifecycle isolated from the main app.

### Release Pipeline

Any new sidecar must be packaged per supported platform and variant:

| Platform | Required consideration |
|---|---|
| macOS Apple Silicon | arm64 binary, codesigning/notarization compatibility |
| macOS Intel | x64 binary if still supported |
| Windows | prebuilt binary, no libclang/bindgen requirement |
| Linux | compatible glibc baseline if Linux builds are distributed |
| GPU variants | optional and explicit; CPU path must remain available |

Release metadata should include:

- sidecar name
- version
- platform
- architecture
- download URL
- SHA-256 checksum
- minimum app version
- supported model runtimes

## Security and Privacy

### Trust Boundaries

The new sidecar boundary is a trust boundary. Model files, catalogue entries, downloaded binaries, and probed metadata must be treated as untrusted inputs.

### Requirements

- Do not execute model files.
- Do not shell out through interpolated command strings.
- Pass sidecar arguments as structured argv arrays.
- Verify checksums for managed sidecar and model downloads.
- Store downloaded binaries and models in app-managed directories.
- Do not upload local model metadata or local file paths to Supabase.
- Do not expose absolute local paths in telemetry, logs, screenshots, or error messages shown outside the local machine.
- Sanitize GGUF metadata before rendering in UI.
- Limit sidecar filesystem access to selected audio/model paths.
- Surface sidecar errors without dumping raw stderr when it may contain local paths.
- Keep cloud/local mode behavior unchanged.

### Prompt-Injection / Metadata-Injection Risk

Model metadata can contain arbitrary strings. Treat all metadata as display text only. It must not influence commands, configuration, shell arguments, policy, hidden prompts, or provider selection except through validated schema fields.

## Testing Strategy

### Frontend Unit Tests

Cover:

- catalogue parsing with new `architecture`, `runtime`, and `capabilities` fields
- fallback behavior when capabilities are missing
- provider selection preserving Whisper/Parakeet defaults
- mode-specific override behavior
- UI rendering of unknown or unsupported architectures

Likely commands:

```bash
pnpm lint
pnpm build
```

If a test runner exists in the repo, add targeted tests and run the existing test command.

### Rust Tests

Cover:

- model path validation
- checksum validation
- sidecar manifest parsing
- command argv construction
- rejection of unsupported model/runtime combinations
- redaction of local paths in user-facing errors

### Integration Tests

Use mocked sidecar binaries or fixtures that simulate:

- successful probe response
- unsupported architecture
- corrupt model metadata
- failed checksum
- sidecar missing
- sidecar timeout
- transcription success
- structured sidecar error

### Manual QA

Verify:

1. Default install still uses existing Whisper/Parakeet defaults.
2. Existing local Whisper transcription still works.
3. Existing Parakeet transcription still works.
4. Multi-architecture feature is hidden or disabled until explicitly opted in.
5. Selecting a supported pilot GGUF/ONNX model enables transcription.
6. Unsupported model files produce clear, non-sensitive errors.
7. Overlay recording flow is unchanged.
8. Main settings UI reflects model architecture and capabilities accurately.
9. App restart preserves selected model and mode settings.
10. Offline behavior remains predictable for already-downloaded runtimes.

## Screenshots / Visual Review

Capture screenshots for the implementation PR showing:

1. Existing model settings screen before enabling multi-architecture support.
2. Opt-in control or experimental section for multi-architecture models.
3. Catalogue list with architecture, runtime, size, quantization, and capabilities.
4. Unsupported model state.
5. Model probe result state.
6. Download/install progress for a sidecar-backed model.
7. Successful selected multi-architecture model state.
8. Error state with redacted local paths.

Screenshots must not include personal names, local absolute paths, emails, tokens, or private project names.

## Boundaries

### Always Do

- Keep Whisper and Parakeet defaults unchanged.
- Use sidecar execution, not in-process GGUF linking.
- Validate catalogue entries and probed metadata.
- Verify checksums for managed downloads.
- Return structured errors.
- Preserve local/cloud app mode behavior.
- Add tests for provider selection and runtime safety.

### Ask First

- Adding new mandatory dependencies.
- Changing release signing/notarization flow.
- Making multi-architecture models default.
- Uploading model metadata to cloud services.
- Removing existing Whisper or Parakeet paths.
- Adding GPU-only runtime requirements.

### Never Do

- Link GGUF / whisper.cpp / transcribe-cpp in-process.
- Execute shell commands through string interpolation.
- Trust GGUF metadata as code or configuration.
- Commit model binaries to the repository.
- Commit secrets or private download credentials.
- Log raw local paths or raw sidecar stderr in cloud-visible contexts.

## Implementation Plan

### Phase 1: Catalogue Schema

Extend model catalogue types and validation to represent architecture, runtime, format, quantization, capabilities, and probe source.

Acceptance:

- Existing Whisper and Parakeet catalogue entries still parse.
- New multi-architecture entries can be represented without provider-specific hard-coding.
- Unknown architectures fail gracefully or render as unsupported.

### Phase 2: Runtime Manifest

Add sidecar runtime manifest support for platform-specific binaries.

Acceptance:

- Runtime metadata includes platform, architecture, version, URL, and checksum.
- Unsupported platforms show a clear unavailable state.
- No binary is invoked without checksum validation.

### Phase 3: Probe API

Add frontend and Rust interfaces for probing model metadata.

Acceptance:

- Known GGUF/ONNX fixtures return normalized capabilities.
- Corrupt or unknown files return typed errors.
- UI does not expose raw local paths.

### Phase 4: Provider Integration

Add `MultiArchitectureProvider` and wire it into provider selection behind explicit opt-in model selection.

Acceptance:

- Existing providers remain default.
- Per-mode transcription provider override can select a multi-architecture model.
- Cleanup provider composition remains unchanged.

### Phase 5: Sidecar Execution

Implement sidecar lifecycle and transcription command execution.

Acceptance:

- Sidecar is invoked with structured argv.
- Timeouts and failures are handled.
- Audio input/output paths are controlled.
- Transcription results conform to existing provider result shape.

### Phase 6: UI Integration

Expose model architecture and capability metadata in settings/catalogue UI.

Acceptance:

- Users can distinguish Whisper, Parakeet, GGUF multi-arch, and ONNX runtimes.
- Unsupported capabilities are disabled or clearly labeled.
- Experimental/opt-in status is visible.

### Phase 7: Release Pipeline

Add packaging/download metadata for sidecar binaries.

Acceptance:

- Each supported platform has manifest entries.
- Missing variants fail gracefully.
- Checksums are documented and enforced.

## Acceptance Criteria

- Verbatim supports a sidecar-backed multi-architecture model runtime path.
- No in-process GGUF, whisper.cpp, or transcribe-cpp linking is introduced.
- Whisper and Parakeet remain default and non-regressed.
- Catalogue metadata can represent at least Whisper, Parakeet, and one pilot multi-architecture runtime.
- Capability probing supports static metadata and sidecar/GGUF-derived metadata.
- Unsupported models and platforms produce clear, typed, non-sensitive errors.
- Managed downloads verify SHA-256 checksums before execution.
- Provider selection works globally and per mode.
- Overlay recording and paste flow remain unchanged.
- Tests cover catalogue parsing, provider selection, sidecar command safety, checksum validation, and error redaction.
- Screenshots demonstrate opt-in UI, catalogue metadata, success state, and redacted error state.

## Open Questions

1. Which sidecar should be used for the first pilot: transcribe-cpp-style GGUF server, sherpa-onnx, or both behind the same abstraction?
2. Which model architecture should be the pilot acceptance target?
3. Which platforms must be supported in the first release?
4. Should GPU variants be deferred until CPU sidecar support is stable?
5. Should bring-your-own GGUF probing be available before curated downloads?
6. What is the minimum acceptable capability metadata for a model to appear selectable?
```

