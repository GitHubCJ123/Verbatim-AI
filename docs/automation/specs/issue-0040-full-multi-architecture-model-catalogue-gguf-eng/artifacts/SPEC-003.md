<!-- verbatim-ai:artifact:v1 issue=40 phase=spec id=issue-0040-issue-0040-4979ba32-6511-48f6-8289-b68d23dcf476-SPEC-003 display=SPEC-003 run=issue-0040-4979ba32-6511-48f6-8289-b68d23dcf476 -->
# SPEC-003: Architect spec

- Issue: #40
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0040-issue-0040-4979ba32-6511-48f6-8289-b68d23dcf476-SPEC-003
- Agent: architect
- Run: issue-0040-4979ba32-6511-48f6-8289-b68d23dcf476
- Created: 2026-07-24T16:12:37.142Z

## Summary

Spec

## Body

# Spec

Proposed `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md`:

```markdown
# Spec: Full Multi-Architecture Model Catalogue via GGUF Sidecar Engine

## Objective

Verbatim AI should support a Handy-parity breadth of ASR model architectures without reintroducing in-process `whisper.cpp` / GGUF linking risk. The feature adds an opt-in, sidecar-based multi-architecture GGUF transcription engine and extends the existing data-driven model catalogue so Verbatim can list, validate, download, probe, and run models beyond Whisper GGML and Parakeet ONNX.

Success means users can enable an experimental multi-architecture catalogue, see architecture-specific capability metadata, install supported models, and transcribe through a sidecar runtime while Whisper and Parakeet remain the stable defaults.

## Assumptions

1. The existing catalogue from issue #31 is data-driven and can be extended rather than replaced.
2. The new runtime must be a prebuilt sidecar binary, not a Rust crate linked into the Tauri process.
3. Whisper GGML and Parakeet ONNX remain default and production-supported.
4. GGUF multi-architecture support is initially opt-in / experimental.
5. Metadata probing must work before a model is selected for transcription where possible.
6. Release packaging must account for macOS, Windows, Linux, CPU, and future GPU variants.

## Problem

Verbatim currently supports only:

- Whisper through GGML / whisper sidecars.
- Parakeet through ONNX / sherpa-onnx sidecars.
- Local cleanup through Ollama.

This leaves a model breadth gap compared with Handy, which supports many ASR architectures such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and others through a GGUF multi-architecture loader.

The architectural challenge is that Verbatim previously avoided in-process `whisper.cpp` integration because Windows bindgen / libclang version mismatches made native linking brittle. This feature must preserve that constraint by keeping GGUF execution out-of-process.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- Rust backend in `src-tauri/`.
- React / TypeScript frontend in `src/`.
- Main settings window and separate overlay window.
- AI provider abstraction in `src/lib/ai/AIProvider.ts`.
- Active provider composition in `src/lib/ai/index.ts`.
- Existing local providers:
  - `src/lib/ai/localWhisper.ts`
  - `src/lib/ai/parakeet.ts`
  - `src/lib/ai/ollama.ts`
- Existing Rust sidecar-style command modules:
  - `src-tauri/src/commands/local_whisper.rs`
  - `src-tauri/src/commands/parakeet.rs`
- Recording flow:
  1. Hotkey events arrive in Rust.
  2. `src/lib/recording-bridge.ts` starts overlay recording.
  3. `src/overlay/Overlay.tsx` captures audio.
  4. `getActiveProvider(mode?)` selects transcription and cleanup providers.
  5. Rust `paste_to_target` pastes cleaned text.
- State uses Zustand stores in `src/lib/store/`.
- Local app mode stores model/settings data in localStorage under `sw.*`.
- Cloud app mode hydrates from Supabase but overlay still reads synchronous localStorage cache.
- Styling must use CSS variables from `src/styles/tokens.css`.

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript + Vite
- State: Zustand
- Styling: Tailwind mapped to CSS custom properties
- Existing cloud backend: Supabase Edge Functions
- Existing sidecar pattern: downloaded prebuilt binaries invoked by Rust commands
- Proposed runtime: GGUF multi-architecture ASR sidecar, preferably server-capable

## Commands

Future implementation should validate with the existing repo commands:

```bash
pnpm install
pnpm lint
pnpm build
pnpm tauri build
```

Targeted Rust validation should use existing Cargo commands from `src-tauri/` where applicable:

```bash
cd src-tauri && cargo test
cd src-tauri && cargo check
```

Manual development commands:

```bash
pnpm dev
pnpm tauri dev
```

## Project Structure

Likely implementation locations:

```text
src/lib/ai/
  AIProvider.ts              Existing provider contract
  index.ts                   Existing provider composition
  ggufMultiArch.ts           New TypeScript provider wrapper

src/lib/store/
  profile/settings stores    Add selected GGUF model / experimental flag if no dedicated store exists

src/
  catalogue/model UI         Extend existing model catalogue UI with architecture/capability metadata

src-tauri/src/commands/
  gguf_multiarch.rs          New sidecar management, probing, transcription command

src-tauri/src/
  main.rs / lib.rs           Register new command module

src-tauri/
  tauri.conf.json            Bundle/download sidecar configuration if required

docs/automation/specs/
  issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md

tests / existing test dirs
  Add unit/integration tests next to existing catalogue/provider tests
```

Exact file names should follow the existing catalogue and provider naming once implementation starts.

## Architecture

### High-Level Design

Add a new experimental transcription engine:

```text
React settings/catalogue UI
        |
        v
Zustand settings + localStorage cache
        |
        v
getActiveProvider(mode?)
        |
        v
GGUFMultiArchProvider
        |
        v
Tauri command: transcribe_gguf_multiarch / probe_gguf_model
        |
        v
Downloaded sidecar binary
        |
        v
GGUF model file
```

The sidecar must be the only component that loads GGUF model weights. Rust should spawn and supervise the process, pass file paths and request metadata, and parse structured JSON output.

### Runtime Strategy

Prefer a server-style sidecar if available:

- Start once per selected model.
- Reuse process across recordings.
- Health check before use.
- Restart on crash.
- Clear error reporting to UI.

Fallback to a CLI invocation is acceptable for an initial implementation only if startup latency is documented and bounded.

The implementation must not:

- Link `whisper.cpp`, `ggml`, `gguf`, or transcribe-cpp directly into the Tauri Rust binary.
- Require bindgen or libclang for normal app builds.
- Block existing Whisper or Parakeet behavior.

### Catalogue Model Schema

Extend the data-driven catalogue with fields similar to:

```ts
type ASRArchitecture =
  | "whisper"
  | "parakeet"
  | "canary"
  | "voxtral"
  | "qwen3-asr"
  | "moonshine"
  | "gigaam"
  | "granite"
  | "sensevoice"
  | "unknown-gguf";

type ModelRuntime = "whisper-ggml" | "parakeet-onnx" | "gguf-multiarch";

type ModelCapability = {
  languages?: string[];
  streaming?: boolean;
  translation?: boolean;
  languageDetection?: boolean;
  timestamps?: boolean;
  diarization?: boolean;
};

type CatalogueModel = {
  id: string;
  displayName: string;
  architecture: ASRArchitecture;
  runtime: ModelRuntime;
  format: "ggml" | "onnx" | "gguf";
  downloadUrl?: string;
  checksumSha256?: string;
  sizeBytes?: number;
  capabilities: ModelCapability;
  metadataProbe?: {
    supported: boolean;
    source: "catalogue" | "gguf-header" | "sidecar";
  };
  experimental?: boolean;
};
```

The exact types should reuse existing catalogue abstractions from #31.

### GGUF Metadata Probing

Add a probe flow that can inspect a local GGUF file before transcription:

```text
User selects/downloads GGUF model
        |
        v
Rust invokes sidecar probe command
        |
        v
Sidecar reads GGUF header only where possible
        |
        v
Returns normalized JSON metadata
        |
        v
UI displays architecture, languages, and capabilities
```

Probe output should be normalized into stable app-level fields. Unknown metadata should not be surfaced raw.

Expected normalized metadata:

```json
{
  "architecture": "sensevoice",
  "languages": ["en", "zh", "ja"],
  "supportsStreaming": false,
  "supportsTranslation": false,
  "supportsLanguageDetection": true,
  "supportsTimestamps": true
}
```

### Provider Integration

`GGUFMultiArchProvider` should implement the same transcription contract as existing providers.

Expected behavior:

- If selected model is unavailable, return a clear setup error.
- If sidecar is missing, trigger existing download/install flow where possible.
- If probe says architecture unsupported, block selection with a visible reason.
- If transcription fails, surface a provider-specific error without falling back silently to another model.
- Cleanup provider selection remains independent and continues using the existing composite provider logic.

### UI / UX

The catalogue should show:

- Runtime: Whisper GGML, Parakeet ONNX, or GGUF Multi-Arch.
- Architecture.
- Model size / quantization where known.
- Capability badges:
  - Languages
  - Streaming
  - Translation
  - Language detection
  - Timestamps
- Experimental label for GGUF multi-architecture models.
- Install/probe status.
- Clear unsupported-platform messaging.

Defaults:

- Existing default transcription behavior remains unchanged.
- GGUF multi-architecture catalogue is hidden or disabled unless the experimental setting is enabled.
- Users can opt into a specific GGUF model per global settings and, if current Mode overrides support it, per Mode.

### Release Pipeline

The implementation must define how sidecars are obtained per platform:

- macOS arm64
- macOS x64 if supported by the app
- Windows x64
- Linux x64 if supported by the app
- CPU baseline variants
- Optional GPU variants as future work

Each sidecar artifact needs:

- Version
- Platform
- Architecture
- Download URL
- SHA-256 checksum
- Runtime capability manifest
- Minimum app version if needed

Bundling and downloading should follow the existing Whisper / Parakeet sidecar pattern.

## Security

### Sidecar Trust

- Downloaded sidecars must be verified with SHA-256 before execution.
- Sidecar paths must be app-managed, not arbitrary user-provided executable paths.
- Runtime version and checksum should be recorded in app state or logs.
- Do not execute a sidecar if checksum validation fails.

### Model File Handling

- Treat GGUF files as untrusted input.
- Probe metadata through the sidecar, not by writing a custom unsafe parser unless necessary.
- Validate file extension, path location, size, and existence before invoking the sidecar.
- Do not pass user-controlled strings through a shell.
- Use process argument arrays, not shell command strings.

### Process Isolation

- Keep GGUF loading out-of-process.
- Capture stdout/stderr with size limits.
- Require structured JSON for machine-readable responses.
- Timeout probe and transcription calls.
- Kill orphaned sidecar processes on app shutdown or provider switch.

### Privacy

- Audio must remain local when using the GGUF sidecar.
- Do not upload model metadata, local file paths, or transcription audio as part of probing.
- Logs must not include full user transcript content by default.
- Logs should avoid absolute paths where possible.

### Prompt Injection / Metadata Injection

GGUF metadata is untrusted. The app must not render arbitrary metadata as HTML or use metadata to modify runtime behavior outside the normalized schema.

## Code Style

Follow existing TypeScript provider style and keep provider errors explicit:

```ts
export class GGUFMultiArchProvider implements AIProvider {
  async transcribe(audioBlob: Blob, mode?: Mode): Promise<string> {
    const model = resolveGGUFModel(mode);

    if (!model) {
      throw new Error("No GGUF multi-architecture model is selected.");
    }

    const result = await invoke<GGUFTranscriptionResult>("transcribe_gguf_multiarch", {
      modelId: model.id,
      audioPath: await persistAudioForSidecar(audioBlob),
    });

    return result.text;
  }
}
```

Guidelines:

- Reuse existing provider abstractions.
- Prefer typed result objects over untyped JSON.
- Keep Rust command input structs explicit and serializable.
- Avoid `any` and broad catch blocks.
- Preserve current default provider behavior.
- Use existing design tokens for UI.

## Testing Strategy

### Unit Tests

Cover:

- Catalogue schema parsing.
- Runtime/architecture filtering.
- Capability normalization.
- Unsupported architecture handling.
- Provider selection with global and per-Mode overrides.
- Experimental flag gating.
- Error messages for missing sidecar, missing model, failed probe, checksum mismatch.

### Rust Tests

Cover:

- Sidecar manifest parsing.
- Platform artifact selection.
- Checksum validation.
- Safe command argument construction.
- Probe JSON parsing.
- Timeout/error mapping.

### Integration Tests

Cover:

- Selecting a GGUF model updates settings and overlay-readable cache.
- `getActiveProvider(mode?)` returns GGUF provider only when selected and enabled.
- Whisper and Parakeet defaults remain unchanged.
- Probe failure prevents model activation.
- Downloaded sidecar checksum failure blocks execution.

### Manual QA

Run through:

1. Fresh install defaults to existing stable provider.
2. Enable experimental GGUF catalogue.
3. Install/probe a supported GGUF model.
4. Select the model globally.
5. Record audio and confirm local transcription.
6. Switch back to Whisper.
7. Confirm no regression in existing recording/paste flow.
8. Simulate unsupported platform and confirm clear UI.
9. Simulate sidecar crash and confirm visible recoverable error.

## Screenshots

Implementation PR should include screenshots or screen recordings for:

1. Default catalogue with GGUF experimental models hidden or disabled.
2. Experimental catalogue enabled with multi-architecture models visible.
3. Model detail view showing architecture and capability badges.
4. Sidecar/model download or install status.
5. Successful metadata probe result.
6. Unsupported model or unsupported platform error.
7. Selected GGUF model in settings.
8. Existing Whisper or Parakeet default still available.

## Boundaries

### Always Do

- Keep GGUF execution in a sidecar process.
- Preserve existing Whisper and Parakeet defaults.
- Verify sidecar checksums before execution.
- Treat GGUF metadata as untrusted input.
- Surface explicit errors instead of silently falling back.
- Add tests for provider selection and capability probing.
- Use existing sidecar/download patterns where possible.

### Ask First

- Adding a new required runtime dependency.
- Changing release CI or installer behavior.
- Changing the provider interface used by existing providers.
- Enabling GGUF multi-architecture models by default.
- Adding cloud syncing for model catalogue preferences if not already supported.

### Never Do

- Link GGUF / whisper.cpp / transcribe-cpp directly into the Tauri process.
- Require bindgen/libclang for normal app builds.
- Execute arbitrary user-selected binaries.
- Skip checksum validation for downloaded sidecars.
- Log raw transcript text, secrets, or full local filesystem paths by default.
- Remove existing Whisper or Parakeet support.

## Implementation Plan

### Phase 1: Catalogue and Capability Model

Add architecture/runtime/capability fields to the existing data-driven catalogue.

Acceptance:

- Existing Whisper and Parakeet catalogue entries still parse.
- GGUF entries can be represented without provider support enabled.
- Experimental GGUF entries are gated in UI/state.

### Phase 2: Sidecar Manifest and Installer

Add a sidecar manifest for the GGUF multi-architecture runtime and reuse existing download/checksum patterns.

Acceptance:

- App can resolve the correct sidecar artifact for the current platform.
- Checksum failure prevents execution.
- Missing platform has a clear user-facing error.

### Phase 3: Metadata Probe Command

Add a Rust Tauri command that invokes the sidecar in probe mode and returns normalized metadata.

Acceptance:

- Probe reads local GGUF metadata without transcription.
- Unknown or unsupported architecture returns a typed unsupported result.
- Probe output never exposes raw arbitrary metadata to the UI.

### Phase 4: Provider Integration

Add `GGUFMultiArchProvider` and wire it into `getActiveProvider(mode?)`.

Acceptance:

- Provider is selected only when explicitly configured.
- Existing providers remain unchanged.
- Transcription errors are visible and provider-specific.

### Phase 5: UI Integration

Extend catalogue/settings UI with architecture, runtime, capabilities, experimental status, install status, and probe results.

Acceptance:

- User can discover, install/probe, and select a supported GGUF model.
- Unsupported models/platforms are understandable.
- UI uses existing design tokens.

### Phase 6: Release and QA

Document and validate sidecar packaging, platform support, and manual QA flows.

Acceptance:

- Release process knows which sidecar artifacts are required.
- Screenshots are attached.
- Existing build/lint/test checks pass.

## Acceptance Criteria

- [ ] Verbatim has a catalogue representation for multiple ASR architectures beyond Whisper and Parakeet.
- [ ] GGUF multi-architecture models are opt-in / experimental.
- [ ] Whisper and Parakeet remain default and non-regressed.
- [ ] No in-process GGUF/whisper.cpp/transcribe-cpp linking is introduced.
- [ ] A prebuilt sidecar runtime is used for GGUF model loading.
- [ ] Sidecar artifacts are platform-specific and checksum-verified.
- [ ] Local GGUF model metadata can be probed into normalized capability fields.
- [ ] Unsupported architectures and platforms are blocked with clear errors.
- [ ] Provider selection supports GGUF globally and, where existing settings allow, per Mode.
- [ ] Transcription through a supported GGUF model works end-to-end.
- [ ] Sidecar crash/missing binary/checksum failure cases are tested.
- [ ] Existing recording, cleanup, and paste flow continues to work.
- [ ] UI screenshots demonstrate the new catalogue and no-regression defaults.
- [ ] Documentation explains runtime support, experimental status, and release packaging needs.

## Non-Goals

- In-process GGUF or whisper.cpp linking.
- Replacing Whisper or Parakeet as defaults.
- Guaranteeing all Handy models work in the first release.
- Building a custom GGUF parser in Rust unless the sidecar cannot expose required metadata.
- Adding cloud-hosted transcription for these models.
- Enabling GPU acceleration by default.

## Open Questions

1. Which exact sidecar implementation should be adopted first: transcribe-cpp-style server, sherpa-onnx per-architecture runtime, or another maintained GGUF ASR server?
2. Which initial architectures are required for MVP?
3. Which platforms must ship in the first release?
4. Should BYO GGUF files be allowed immediately, or only catalogue-managed downloads?
5. Should GGUF model selection be global-only initially, or support per-Mode overrides from day one?
6. What is the acceptable startup latency for a CLI-style sidecar if a persistent server is not available?
7. Are GPU variants part of the first implementation or explicitly deferred?
```

