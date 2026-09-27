<!-- verbatim-ai:artifact:v1 issue=40 phase=spec id=issue-0040-issue-0040-612b9e89-0cd5-466f-9309-93b2e34872a3-SPEC-005 display=SPEC-005 run=issue-0040-612b9e89-0cd5-466f-9309-93b2e34872a3 -->
# SPEC-005: Architect spec

- Issue: #40
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0040-issue-0040-612b9e89-0cd5-466f-9309-93b2e34872a3-SPEC-005
- Agent: architect
- Run: issue-0040-612b9e89-0cd5-466f-9309-93b2e34872a3
- Created: 2026-07-25T00:28:32.311Z

## Summary

Spec

## Body

# Spec

Here is proposed content for `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md`:

```markdown
# Spec: Issue #40 - Full Multi-Architecture Model Catalogue via GGUF Sidecar Engine

## Objective

Verbatim AI should support a broader ASR model catalogue comparable to Handy’s multi-architecture model breadth while preserving Verbatim’s current sidecar-based runtime architecture.

The goal is to add an opt-in, data-driven multi-architecture model path that can run GGUF ASR models through an external sidecar engine, without linking whisper.cpp/GGUF code in-process. Whisper and Parakeet remain the default, stable engines.

Success means Verbatim can catalogue, display, download, validate, and run GGUF ASR models across multiple architectures through a sidecar abstraction, while clearly exposing per-model capabilities such as supported languages, translation, streaming, and language detection.

## Problem

The existing catalogue work supports bring-your-own GGML discovery and a compact set of quantized large-tier models, but runtime execution is still limited to:

- Whisper-compatible GGML models through Whisper sidecars.
- Parakeet ONNX models through sherpa-onnx sidecars.

This does not close the model-breadth gap for architectures such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and similar non-Whisper ASR families.

Handy achieves that breadth through a GGUF multi-architecture loader. Verbatim should not adopt in-process GGUF/whisper.cpp linking because prior Windows builds encountered bindgen/libclang compatibility risk. Any GGUF multi-architecture support must therefore be sidecar-based.

## Assumptions

1. The first implementation should introduce the engine abstraction and catalogue plumbing before claiming full parity with every Handy model.
2. The GGUF engine is distributed as a downloaded sidecar binary, similar to local Whisper and Parakeet runtimes.
3. Model metadata should be data-driven and should not require hard-coding model-specific behavior in UI components.
4. Existing Whisper and Parakeet behavior must remain unchanged unless the user explicitly opts into the new GGUF engine or model family.
5. GPU-specific runtime variants, if supported, are selected through the same runtime capability/download mechanism used by other local engines.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- React/TypeScript frontend in `src/`.
- Rust backend in `src-tauri/`.
- Two Tauri windows:
  - `main` for settings and management UI.
  - `overlay` for the always-on-top recording/transcription pill.
- Local ASR providers implemented behind the frontend AI provider abstraction:
  - `src/lib/ai/localWhisper.ts`
  - `src/lib/ai/parakeet.ts`
  - `src/lib/ai/ollama.ts`
  - `src/lib/ai/index.ts`
  - `src/lib/ai/AIProvider.ts`
- Rust sidecar/download command patterns under:
  - `src-tauri/src/commands/local_whisper.rs`
  - `src-tauri/src/commands/parakeet.rs`
- Recording flow:
  1. Hotkey events are emitted from Rust.
  2. `src/lib/recording-bridge.ts` starts the overlay recording flow.
  3. `src/overlay/Overlay.tsx` captures audio.
  4. `getActiveProvider(mode?)` selects transcription and cleanup providers.
  5. Final text is pasted through the Rust `paste_to_target` command.
- State is managed with Zustand stores under `src/lib/store/`.
- Local/cloud app mode is controlled by `src/lib/appMode.ts`.
- Styling should use CSS custom properties from `src/styles/tokens.css`.

## Proposed Architecture

### 1. Add a GGUF Multi-Architecture Engine Type

Introduce a new local transcription engine category, tentatively named `gguf-multiarch`, distinct from existing Whisper GGML and Parakeet ONNX engines.

The engine should be represented in the existing data-driven catalogue with fields such as:

```ts
type AsrArchitecture =
  | 'whisper'
  | 'parakeet'
  | 'canary'
  | 'voxtral'
  | 'qwen3-asr'
  | 'moonshine'
  | 'gigaam'
  | 'granite'
  | 'sensevoice'
  | 'unknown';

type ModelRuntimeEngine =
  | 'whisper-ggml'
  | 'parakeet-onnx'
  | 'gguf-multiarch';

type ModelCapability = {
  languages?: string[];
  supportsStreaming?: boolean;
  supportsTranslation?: boolean;
  supportsLanguageDetection?: boolean;
  supportsTimestamps?: boolean;
};
```

The final names should match existing catalogue conventions.

### 2. Add a GGUF Sidecar Provider

Add a provider parallel to `LocalWhisperProvider` and `ParakeetProvider`, for example:

- `src/lib/ai/ggufMultiarch.ts`

Responsibilities:

- Validate that the selected model uses the GGUF multi-architecture runtime.
- Ensure the sidecar binary is installed.
- Ensure the selected GGUF model is present.
- Invoke the Rust Tauri command for transcription.
- Return the same normalized transcription result shape used by existing providers.
- Surface structured errors for unsupported architecture, missing runtime, invalid metadata, or failed transcription.

The provider should plug into `getActiveProvider(mode?)` through the same composite-provider mechanism used today.

### 3. Add Rust Sidecar Commands

Add a Rust command module similar to the existing local runtime command modules, for example:

- `src-tauri/src/commands/gguf_multiarch.rs`

Responsibilities:

- Download or locate the GGUF engine sidecar.
- Report installation/runtime status.
- Validate model compatibility.
- Probe GGUF metadata.
- Run transcription in a child process.
- Capture stdout/stderr safely.
- Return structured errors to the frontend.

The command should avoid in-process linking. It should execute a prebuilt sidecar binary only.

Expected command surface:

```rust
#[tauri::command]
async fn gguf_multiarch_status() -> Result<GgufRuntimeStatus, String>;

#[tauri::command]
async fn gguf_multiarch_probe_model(path: String) -> Result<GgufModelMetadata, String>;

#[tauri::command]
async fn gguf_multiarch_transcribe(request: GgufTranscribeRequest) -> Result<GgufTranscribeResult, String>;
```

Exact names should follow existing command naming conventions.

### 4. Metadata and Capability Probing

The catalogue should support both declared and probed capabilities.

Declared catalogue metadata should include:

- Model ID.
- Display name.
- Architecture.
- Runtime engine.
- Download URL/checksum/size.
- Quantization.
- Language support when known.
- Feature support when known.
- Minimum runtime version.
- Platform/runtime constraints.

Probed GGUF metadata should be used to verify:

- Architecture family.
- Tokenizer/model metadata compatibility.
- Language list if present.
- Whether translation, language detection, streaming, timestamps, or diarization are advertised.
- Whether the runtime sidecar supports the model.

If metadata is absent or incomplete, the UI should clearly show “unknown” rather than assuming support.

### 5. UI Integration

The model catalogue UI should expose GGUF multi-architecture models as an opt-in advanced/local model category.

UI requirements:

- Existing Whisper and Parakeet defaults remain unchanged.
- Users can filter or identify models by architecture.
- Users can see whether a model is experimental or unsupported on their current platform.
- Users can see model capabilities before download.
- Incompatible models should be disabled with an explanatory reason.
- Runtime download/install state should be visible.
- Errors should be actionable and not expose sensitive local paths unnecessarily.

### 6. Release and Runtime Distribution

The release pipeline must account for sidecar binaries by platform and architecture.

Required metadata per binary:

- Platform: macOS, Windows, Linux if supported.
- CPU architecture: arm64/x64.
- Optional GPU variant if supported.
- Version.
- SHA-256 checksum.
- Download URL.
- Minimum app version.
- Runtime feature flags/capabilities.

The app should verify checksums before executing downloaded binaries.

## Security and Privacy

### Sidecar Execution

- Never execute arbitrary user-selected binaries as the GGUF runtime.
- Only execute sidecars from trusted release metadata or explicitly supported local development paths.
- Verify downloaded binary checksums before first use.
- Store sidecars in the same controlled app data location as existing local runtimes.
- Avoid shell invocation; use direct process execution with explicit args.
- Sanitize all arguments passed to the sidecar.
- Enforce timeouts and child-process cleanup.

### Model Files

- User-provided GGUF paths must be treated as untrusted.
- Do not parse model metadata with unsafe assumptions.
- Do not expose full absolute paths in UI errors unless existing repo conventions allow it.
- Do not upload local model files or metadata to cloud services.

### Logs and Errors

- Do not log transcripts, raw audio paths, auth tokens, Supabase keys, or full local filesystem paths.
- Runtime stderr should be captured for diagnostics but redacted before display.
- Structured errors should distinguish:
  - Runtime missing.
  - Unsupported platform.
  - Unsupported architecture.
  - Invalid model metadata.
  - Transcription failure.
  - Permission/file access failure.

### Network

- Runtime and model downloads must use HTTPS.
- Checksum verification is required.
- Download URLs should come from trusted catalogue/release metadata.

## Testing Strategy

### Unit Tests

Add or update tests for:

- Catalogue parsing of architecture/runtime fields.
- Capability normalization.
- GGUF metadata probe result mapping.
- Provider selection when mode uses `gguf-multiarch`.
- Error mapping from Rust/Tauri command failures to UI/provider errors.
- Backward compatibility for existing Whisper and Parakeet catalogue entries.

### Rust Tests

Add tests where practical for:

- Runtime metadata structs.
- Checksum validation helpers.
- Sidecar argument construction.
- Metadata parsing from representative sidecar probe output.
- Error classification.

### Integration Tests

Cover:

1. Existing Whisper transcription path still selects the existing provider.
2. Existing Parakeet transcription path still selects the existing provider.
3. GGUF model selection invokes the GGUF sidecar provider.
4. Unsupported GGUF architecture is rejected before transcription.
5. Missing sidecar produces an actionable install/runtime error.
6. Invalid GGUF metadata does not crash the UI.

### Manual QA

Manual checks should include:

- Fresh install with no local runtimes.
- Existing user with Whisper/Parakeet already configured.
- Switching between Whisper, Parakeet, and GGUF models.
- Download cancellation/failure.
- Offline behavior.
- Corrupt model file.
- Unsupported platform/runtime variant.
- Successful short transcription with at least one known-compatible GGUF model.

## Commands

Use existing repo commands:

```bash
pnpm install
pnpm build
pnpm lint
pnpm tauri dev
pnpm tauri build
```

Targeted test commands should be added to this section once existing test scripts for this area are confirmed.

## Screenshots and Visual Review

The implementation PR should include screenshots or short screen recordings for:

1. Model catalogue showing GGUF multi-architecture models.
2. Architecture/capability details for a GGUF model.
3. Runtime missing/download state.
4. Incompatible model disabled state.
5. Successful GGUF model selected in settings.
6. Error state for unsupported/corrupt model metadata.

Screenshots must not include personal data, local usernames, transcripts containing private content, API keys, or full local filesystem paths.

## Acceptance Criteria

### Functional

- [ ] A new sidecar-based GGUF multi-architecture runtime is represented in the model catalogue.
- [ ] Catalogue entries can declare architecture, runtime engine, quantization, language support, and capabilities.
- [ ] GGUF model metadata can be probed through the sidecar without in-process linking.
- [ ] The app can distinguish supported, unsupported, unknown, and incompatible GGUF models.
- [ ] A selected supported GGUF model can be used for local transcription through the normal provider flow.
- [ ] Existing Whisper and Parakeet model flows remain unchanged by default.
- [ ] The feature is opt-in and non-regressive.

### Architecture

- [ ] No in-process whisper.cpp, GGUF, or transcribe-cpp linking is introduced.
- [ ] GGUF runtime execution happens only through a managed sidecar process.
- [ ] Frontend provider integration follows existing `AIProvider` patterns.
- [ ] Rust command integration follows existing local runtime command patterns.
- [ ] Release metadata supports per-platform sidecar variants and checksums.

### Security

- [ ] Downloaded sidecars are checksum-verified before execution.
- [ ] Sidecar execution does not use shell interpolation.
- [ ] User-provided model paths are treated as untrusted input.
- [ ] Errors/logs do not expose secrets, transcript contents, or unnecessary absolute paths.
- [ ] Invalid/corrupt model metadata fails safely with a structured error.

### Testing

- [ ] Existing build and lint commands pass.
- [ ] Provider-selection tests cover Whisper, Parakeet, and GGUF paths.
- [ ] Catalogue parsing tests cover multi-architecture metadata.
- [ ] Rust-side tests cover sidecar command argument construction and checksum validation where applicable.
- [ ] Manual QA covers install, selection, failure, and successful transcription states.

## Non-Goals

- Do not introduce in-process GGUF or whisper.cpp linking.
- Do not replace Whisper or Parakeet defaults.
- Do not require cloud auth for local GGUF models.
- Do not claim support for every Handy model until each architecture is verified.
- Do not add unsupported GPU/runtime variants without release pipeline support.
- Do not upload local model files or local transcripts as part of metadata probing.

## Open Questions

1. Which GGUF sidecar implementation should be selected first: transcribe-cpp-style server, CLI, or another maintained runtime?
2. Should the first milestone support only CPU runtimes, or include GPU variants?
3. Which initial GGUF architectures should be treated as supported versus experimental?
4. Where should canonical catalogue metadata live if model breadth grows to dozens of entries?
5. Should BYO GGUF models be allowed immediately, or only curated catalogue GGUF downloads for the first release?
```

