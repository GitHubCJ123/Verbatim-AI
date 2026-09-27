<!-- verbatim-ai:artifact:v1 issue=40 phase=spec id=issue-0040-issue-0040-e8c2fafe-1a42-4e79-a1b2-c69e5693a169-SPEC-002 display=SPEC-002 run=issue-0040-e8c2fafe-1a42-4e79-a1b2-c69e5693a169 -->
# SPEC-002: Architect spec

- Issue: #40
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0040-issue-0040-e8c2fafe-1a42-4e79-a1b2-c69e5693a169-SPEC-002
- Agent: architect
- Run: issue-0040-e8c2fafe-1a42-4e79-a1b2-c69e5693a169
- Created: 2026-07-24T12:09:26.558Z

## Summary

Spec

## Body

# Spec

● skill(doc-coauthoring)

Proposed content for `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md`:

```markdown
# Spec: Full Multi-Architecture Model Catalogue via GGUF Sidecar Engine

## Assumptions

1. Verbatim AI should preserve the existing sidecar-only runtime model for native ASR engines.
2. Whisper GGML and Parakeet ONNX remain the default, supported paths.
3. The new multi-architecture catalogue is opt-in until runtime reliability, model compatibility, and release packaging are proven.
4. The implementation should prefer a single GGUF multi-architecture sidecar if viable, but may document sherpa-onnx per-architecture runtimes as a fallback.
5. No in-process whisper.cpp, GGUF, or transcribe-cpp linking is allowed.

## Problem

Verbatim AI currently has a data-driven model catalogue and bring-your-own GGML discovery, but runtime support is limited to existing ASR engines: Whisper GGML and Parakeet ONNX. This prevents Verbatim from reaching Handy-style model breadth across architectures such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and similar ASR families.

The missing capability is not just more catalogue rows. Verbatim needs a runtime abstraction capable of loading and probing multiple model architectures without introducing the prior Windows bindgen/libclang risk caused by in-process native linking.

## Objective

Add a design and implementation path for a multi-architecture ASR model catalogue backed by a GGUF-capable sidecar engine.

Success means Verbatim can list, download/discover, probe, and run non-Whisper ASR models through a sidecar runtime while preserving the current defaults and avoiding regressions to Whisper, Parakeet, local mode, cloud mode, overlay recording, and release packaging.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- React/TypeScript frontend in `src/`.
- Rust backend in `src-tauri/`.
- A main settings window and a separate transparent overlay window.
- Recording flow:
  1. Rust emits global hotkey events.
  2. `src/lib/hotkey.ts` and `src/lib/modeResolver.ts` resolve the active Mode.
  3. `src/lib/recording-bridge.ts` starts overlay recording.
  4. `src/overlay/Overlay.tsx` captures audio.
  5. `src/lib/ai/index.ts` selects the active AI provider.
  6. Rust command `paste_to_target` pastes cleaned text.
- Existing AI providers:
  - `SupabaseAIProvider`
  - `LocalWhisperProvider`
  - `ParakeetProvider`
  - `OllamaProvider` for cleanup only
- Existing Rust sidecar command areas:
  - `src-tauri/src/commands/local_whisper.rs`
  - `src-tauri/src/commands/parakeet.rs`
- Existing model architecture direction:
  - Data-driven catalogue from prior catalogue work.
  - Bring-your-own GGML discovery.
  - No in-process native GGUF or whisper.cpp linking.

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript
- State: Zustand stores under `src/lib/store/`
- Styling: CSS custom properties from `src/styles/tokens.css`
- Runtime engines:
  - Existing: whisper-cli / whisper-server sidecar
  - Existing: sherpa-onnx sidecar for Parakeet
  - New candidate: GGUF multi-architecture ASR sidecar server or CLI
  - Fallback candidate: per-architecture sherpa-onnx runtimes where GGUF support is not viable

## Commands

```bash
pnpm install
pnpm build
pnpm lint
pnpm tauri dev
pnpm tauri build
```

Targeted validation should prefer the smallest relevant command first, then escalate to full build or package validation when release assets are touched.

## Project Structure

```text
src/lib/ai/
  AIProvider.ts              Existing provider interface
  index.ts                   Active/composite provider selection
  localWhisper.ts            Whisper sidecar provider
  parakeet.ts                Parakeet sidecar provider
  ggufMultiArch.ts           Proposed new provider

src/lib/models/ or existing catalogue location
  model catalogue metadata   Extend with architecture, runtime, capabilities, probe metadata

src-tauri/src/commands/
  local_whisper.rs           Existing Whisper sidecar management
  parakeet.rs                Existing Parakeet sidecar management
  gguf_multi_arch.rs         Proposed new sidecar management command module

src-tauri/tauri.conf.json
  Bundle and sidecar configuration

docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/
  spec.md                    This implementation spec
```

## Architecture

### Runtime Strategy

Introduce a new optional runtime family: `gguf_multi_arch`.

The runtime must be implemented as an external sidecar binary, not a library linked into the Tauri Rust process. The sidecar may expose either:

1. A local HTTP server API, preferred for persistent startup and repeated transcription.
2. A CLI process API, acceptable for initial implementation if startup time is reasonable.
3. A hybrid model where Verbatim manages a long-lived process and communicates through stdin/stdout or HTTP.

The runtime adapter should follow the pattern of existing local ASR providers:

- Download or locate the sidecar binary.
- Verify platform compatibility.
- Verify model file compatibility.
- Start or invoke the engine.
- Send audio input.
- Return transcription text plus structured metadata.
- Surface failures clearly to the UI.

### Model Catalogue Extensions

Each catalogue entry should include enough metadata to decide whether it is visible, downloadable, runnable, and selectable.

Proposed fields:

```ts
type ModelRuntime = "whisper_ggml" | "parakeet_onnx" | "gguf_multi_arch";

type ModelArchitecture =
  | "whisper"
  | "parakeet"
  | "canary"
  | "voxtral"
  | "qwen3_asr"
  | "moonshine"
  | "gigaam"
  | "granite"
  | "sensevoice"
  | "unknown";

interface ModelCapabilities {
  languages?: string[];
  supportsStreaming?: boolean;
  supportsTranslation?: boolean;
  supportsLanguageDetection?: boolean;
  supportsTimestamps?: boolean;
}

interface CatalogueModel {
  id: string;
  displayName: string;
  runtime: ModelRuntime;
  architecture: ModelArchitecture;
  format: "ggml" | "gguf" | "onnx";
  downloadUrl?: string;
  localDiscoveryPatterns?: string[];
  expectedMetadata?: Record<string, string | number | boolean>;
  capabilities?: ModelCapabilities;
  capabilityProbe?: "static_catalogue" | "gguf_metadata" | "runtime_probe";
  recommended?: boolean;
  experimental?: boolean;
}
```

### GGUF Metadata Probing

For GGUF models, Verbatim should probe metadata before allowing a model to be marked runnable.

Probe responsibilities:

- Read architecture identifier from GGUF metadata.
- Detect language support when present.
- Detect task support where available:
  - transcription
  - translation
  - language detection
  - timestamps
  - streaming
- Verify that the selected sidecar supports the detected architecture.
- Store derived capabilities in local catalogue cache.

The probe should be conservative. Unknown or missing metadata should not be silently treated as full support.

### Provider Selection

`getActiveProvider(mode?)` should remain the central selection point.

The new provider should only be selected when:

- The selected Mode or global setting explicitly chooses a GGUF multi-architecture model.
- The sidecar is installed and compatible.
- The model has passed metadata/runtime probing.
- The runtime is enabled by user-facing experimental/advanced settings if still considered experimental.

Whisper and Parakeet defaults must not change.

### UI / UX

The model catalogue UI should distinguish:

- Stable models
- Experimental multi-architecture GGUF models
- Installed but unsupported local files
- Downloadable but not installed models
- Models requiring a sidecar download
- Models whose architecture could not be detected

Expected user-facing states:

- “Ready”
- “Download required”
- “Sidecar required”
- “Unsupported architecture”
- “Metadata probe failed”
- “Experimental”

Errors should include actionable next steps without exposing raw command lines, absolute paths, tokens, or internal debug dumps.

### Release Pipeline

The release pipeline must account for:

- Platform-specific sidecar binaries.
- CPU/GPU variants if supported.
- macOS signing/notarization compatibility.
- Windows installer inclusion.
- Linux packaging if applicable.
- Checksums for downloaded binaries.
- Version pinning of sidecar releases.
- Backward-compatible fallback if the sidecar is unavailable.

Bundling should not make the app depend on the new sidecar at startup. Missing sidecar binaries should only affect models that require that runtime.

## Security and Privacy

### Native Runtime Isolation

- The GGUF engine must run as a sidecar process, not linked into the Tauri app.
- The app should pass only necessary file paths and runtime parameters.
- The sidecar should run with least privilege available for the platform.
- No shell interpolation should be used when invoking sidecars.
- Arguments should be passed as structured process args.

### Download Integrity

- Sidecar downloads must be pinned to explicit versions.
- Downloads must verify checksums before execution.
- Failed verification must block execution.
- Auto-update behavior must not execute newly downloaded binaries until verification passes.

### Local File Handling

- Model discovery must restrict itself to user-approved directories or existing app model directories.
- Unsupported files must not be executed or parsed beyond safe metadata probing.
- Absolute paths should not be sent to remote services.
- Error reporting must redact user paths where appropriate.

### Data Privacy

- Local ASR models should process audio locally.
- Audio must not be sent to remote services when a local GGUF model is selected.
- Provider selection must make local/cloud routing explicit.
- Logs must not include transcript content, raw audio, secrets, auth tokens, or full local file paths.

### Prompt Injection / Untrusted Metadata

GGUF metadata, model names, repository names, and downloaded manifest content must be treated as untrusted data.

They must not be used to:

- Construct shell commands.
- Modify app configuration without validation.
- Render unsafe HTML.
- Override provider/runtime selection.
- Change security policy or download destinations.

## Testing Strategy

### Unit Tests

Cover:

- Catalogue schema parsing.
- Runtime compatibility checks.
- GGUF metadata probe result normalization.
- Provider selection with global and per-Mode overrides.
- Capability fallback behavior when metadata is missing.
- Redaction of paths and runtime errors.
- Unsupported architecture handling.

### Integration Tests

Cover:

- Selecting an existing Whisper model still uses the existing Whisper provider.
- Selecting Parakeet still uses the existing Parakeet provider.
- Selecting a GGUF multi-architecture model uses the new provider only when enabled and available.
- Missing sidecar produces an actionable UI state.
- Unsupported GGUF architecture does not crash the app.
- Failed checksum prevents sidecar execution.

### Tauri / Rust Tests

Cover:

- Sidecar path resolution.
- Platform binary selection.
- Process invocation arguments.
- Probe command parsing.
- Error mapping from sidecar failures to frontend-safe errors.

### Manual QA

Perform at least one pass on each supported platform/variant available to the project:

- Fresh install with no GGUF sidecar.
- Install/download sidecar.
- Add supported GGUF model.
- Add unsupported GGUF model.
- Switch between Whisper, Parakeet, and GGUF models.
- Record short audio through overlay.
- Confirm pasted transcription.
- Confirm app restart preserves model selection and catalogue state.

## Screenshots

Capture screenshots for the implementation PR or release notes showing:

1. Model catalogue with GGUF multi-architecture models visible but marked experimental.
2. A model details panel showing architecture and probed capabilities.
3. Missing sidecar state with actionable install/download UI.
4. Unsupported architecture state.
5. Successful selected GGUF model in settings.
6. Overlay recording flow still functioning after selecting a supported GGUF model.

Screenshots must not include personal names, email addresses, transcript content, local absolute paths, tokens, or private model repository identifiers.

## Boundaries

### Always Do

- Keep the runtime sidecar-based.
- Preserve Whisper and Parakeet defaults.
- Treat downloaded manifests and GGUF metadata as untrusted.
- Verify checksums before executing downloaded binaries.
- Provide clear unsupported/experimental states.
- Add tests for provider selection and unsafe metadata handling.
- Redact sensitive paths and transcript content from logs/errors.

### Ask First

- Adding a new bundled binary to release artifacts.
- Adding new external download hosts.
- Changing app defaults away from Whisper or Parakeet.
- Changing cloud/local routing semantics.
- Adding telemetry around model usage.
- Adding new dependency-heavy native build steps.

### Never Do

- Link GGUF, whisper.cpp, or transcribe-cpp in-process.
- Execute model metadata as commands or config.
- Send local audio to cloud services when a local model is selected.
- Log raw transcripts, audio, tokens, or full local paths.
- Make experimental GGUF models the default.
- Break existing Whisper or Parakeet flows.

## Implementation Plan

### Phase 1: Runtime Feasibility

- Evaluate candidate GGUF multi-architecture sidecar engines.
- Confirm platform availability for macOS, Windows, and Linux.
- Confirm supported architectures and GGUF metadata conventions.
- Decide between persistent server, CLI invocation, or fallback ONNX runtime path.

Deliverable: documented runtime choice and compatibility matrix.

### Phase 2: Catalogue Schema Extension

- Add runtime and architecture metadata.
- Add capability fields and probe source.
- Add experimental/support status fields.
- Migrate existing Whisper and Parakeet catalogue entries without behavior changes.

Deliverable: existing catalogue renders identically unless experimental models are enabled.

### Phase 3: Metadata Probe Layer

- Add safe GGUF metadata probing.
- Normalize probe output into catalogue capabilities.
- Store probe results in local cache.
- Add unsupported/unknown state handling.

Deliverable: GGUF files can be classified without being selected for transcription.

### Phase 4: Sidecar Provider

- Add Rust command module for sidecar discovery, download, verification, and invocation.
- Add TypeScript provider adapter.
- Wire into `getActiveProvider(mode?)`.
- Keep failure handling scoped to GGUF-selected models.

Deliverable: supported GGUF model can transcribe a short local recording.

### Phase 5: UI Integration

- Show architecture, capabilities, runtime, and support status in catalogue UI.
- Add sidecar install/download state.
- Add experimental label and opt-in behavior.
- Add actionable errors.

Deliverable: users can understand why a model is or is not runnable.

### Phase 6: Release Packaging

- Add sidecar packaging or download manifest.
- Add checksums.
- Validate installer behavior.
- Document platform limitations.

Deliverable: release process can ship or fetch the sidecar safely.

## Acceptance Criteria

- Whisper and Parakeet continue to work unchanged.
- No in-process GGUF/whisper.cpp/transcribe-cpp linking is introduced.
- Catalogue entries support explicit runtime, architecture, format, capabilities, and experimental status.
- GGUF metadata probing can classify supported, unsupported, and unknown models.
- Unsupported GGUF models cannot be selected as runnable.
- A supported GGUF multi-architecture model can be selected and used for transcription through a sidecar.
- Sidecar download or bundling verifies checksums before execution.
- Provider selection never routes local-model audio to cloud providers.
- UI clearly distinguishes ready, missing sidecar, unsupported architecture, and probe-failed states.
- Logs and user-facing errors avoid transcript content, secrets, and full local paths.
- Tests cover provider selection, catalogue parsing, metadata probing, checksum failure, and unsupported architecture behavior.
- Screenshots demonstrate the catalogue states and successful GGUF selection without exposing PII.

## Open Questions

1. Which GGUF multi-architecture sidecar should be standardized: transcribe-cpp-style server, CLI wrapper, or another maintained engine?
2. Which model architectures are required for the first supported batch?
3. Should GGUF support be hidden behind an experimental app setting, or shown in the catalogue with per-model experimental labels?
4. Are GPU variants required for the first release, or is CPU-only acceptable initially?
5. Should Verbatim bundle the sidecar in installers or download it on demand?
6. What is the minimum supported Windows/macOS/Linux matrix for the new sidecar?
7. Should bring-your-own GGUF model discovery require explicit user-selected directories only?
8. What model source hosts are approved for first-party catalogue downloads?
```

