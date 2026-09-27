# Spec

Proposed content for `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md`:

```markdown
# Spec: Full Multi-Architecture Model Catalogue via GGUF Sidecar Engine

## Objective

Expand Verbatim AI's local ASR model catalogue beyond the current Whisper GGML and Parakeet ONNX engines by designing an opt-in, non-regressive GGUF multi-architecture sidecar path.

The goal is Handy-parity model breadth without reintroducing in-process `whisper.cpp` or GGUF linking. Verbatim should be able to catalogue, download, probe, and run additional ASR model architectures such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and future GGUF-compatible models through an external runtime process.

Success means users can discover and select broader model families from the model catalogue while existing Whisper and Parakeet defaults remain unchanged and stable.

## Problem

Verbatim AI currently supports local transcription through:

- Whisper GGML models via downloaded sidecar binaries.
- Parakeet ONNX models via `sherpa-onnx`.
- Optional cleanup through Ollama.
- Supabase-backed cloud transcription through Edge Functions.

The app does not yet support the broader model architecture catalogue available in Handy-style multi-architecture ASR runtimes. The blocker is architectural: Verbatim intentionally avoids in-process `whisper.cpp` / GGUF linking because prior Windows builds hit bindgen/libclang version-mismatch issues. Any solution must preserve the sidecar boundary.

## Current Repo Facts

Based on the repository architecture:

- Verbatim AI is a Tauri 2 desktop app with:
  - React/TypeScript frontend in `src/`.
  - Rust backend in `src-tauri/`.
  - Main settings window and separate transparent overlay window.
- Recording flow:
  1. Rust emits global hotkey events.
  2. `src/lib/recording-bridge.ts` starts overlay recording.
  3. `src/overlay/Overlay.tsx` captures microphone audio.
  4. `src/lib/ai/index.ts` selects an active provider.
  5. Rust command `paste_to_target` pastes the final text.
- Current provider abstractions live around:
  - `src/lib/ai/AIProvider.ts`
  - `src/lib/ai/index.ts`
  - `src/lib/ai/localWhisper.ts`
  - `src/lib/ai/parakeet.ts`
  - `src/lib/ai/ollama.ts`
- Existing Rust command patterns for local runtimes live in:
  - `src-tauri/src/commands/local_whisper.rs`
  - `src-tauri/src/commands/parakeet.rs`
- The app already has a data-driven catalogue direction from prior work and should extend that model rather than hardcoding one-off providers.
- App modes are:
  - `local`: no Supabase auth, localStorage-backed modes/vocab.
  - `cloud`: Supabase auth and sync.
- Whisper and Parakeet must remain the default safe paths.

## Non-Goals

- No in-process GGUF, `whisper.cpp`, or multi-architecture ASR linking.
- No removal or regression of existing Whisper or Parakeet support.
- No mandatory download of new large sidecars or models.
- No cloud-mode dependency for local GGUF catalogue usage.
- No bundling of unverified model binaries without checksum/version metadata.
- No silent fallback that makes users believe a selected model ran when it did not.

## Proposed Architecture

### 1. Add a GGUF ASR sidecar engine abstraction

Introduce a new local runtime family for multi-architecture GGUF ASR, implemented as an external process.

Candidate naming:

- TypeScript provider: `GgufAsrProvider`
- Rust command module: `gguf_asr.rs`
- Runtime family id: `gguf-asr`
- Engine binary kind: `transcribe-cpp`-compatible sidecar, or equivalent prebuilt server/CLI that can auto-detect architecture from GGUF metadata.

The sidecar should follow existing local runtime patterns:

- Downloaded and managed by Rust commands.
- Invoked out-of-process.
- Versioned per platform and architecture.
- Checked by hash.
- Never linked into the Tauri binary.

### 2. Prefer server-style lifecycle if available

If the selected GGUF runtime supports a persistent server mode, prefer that over per-request process startup.

Expected lifecycle:

1. Ensure engine binary is installed.
2. Ensure selected model is downloaded.
3. Start or reuse a local sidecar process.
4. Send audio file/path/request to sidecar.
5. Receive transcription result.
6. Surface structured errors to UI.

If only CLI mode is available initially, the provider may use one-shot invocation, but the abstraction should not prevent a later persistent server implementation.

### 3. Extend the data-driven model catalogue

The catalogue should represent model architecture and runtime requirements explicitly.

Proposed model metadata shape:

```ts
type LocalAsrEngine = "whisper-ggml" | "parakeet-onnx" | "gguf-asr";

type AsrArchitecture =
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

interface ModelCatalogueEntry {
  id: string;
  displayName: string;
  engine: LocalAsrEngine;
  architecture: AsrArchitecture;
  modelFormat: "ggml" | "onnx" | "gguf";
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  recommended?: boolean;
  experimental?: boolean;
  capabilities: ModelCapabilities;
  requirements: ModelRuntimeRequirements;
}

interface ModelCapabilities {
  languages: string[] | "probe-required" | "unknown";
  supportsStreaming: boolean | "unknown";
  supportsTranslation: boolean | "unknown";
  supportsLanguageDetection: boolean | "unknown";
  supportsTimestamps: boolean | "unknown";
}

interface ModelRuntimeRequirements {
  minMemoryBytes?: number;
  gpuAcceleration?: "none" | "optional" | "required";
  supportedPlatforms: Array<"macos-arm64" | "macos-x64" | "windows-x64" | "linux-x64">;
  sidecarVariant?: string;
}
```

### 4. Add GGUF metadata probing

GGUF models should be probed before being shown as fully available.

Probe responsibilities:

- Read architecture identifier from GGUF metadata.
- Confirm the selected runtime supports that architecture.
- Extract capability hints when available:
  - languages
  - translation support
  - language detection support
  - streaming support
  - timestamp support
- Validate model file integrity and expected format.
- Cache probe results with model version/hash.

Probe result shape:

```ts
interface GgufProbeResult {
  modelPath: string;
  sha256: string;
  architecture: AsrArchitecture;
  runtimeCompatible: boolean;
  capabilities: ModelCapabilities;
  warnings: string[];
}
```

If the runtime cannot probe metadata directly, implement a Rust-side lightweight metadata reader only if it does not require linking against unstable GGUF engine libraries. Otherwise, delegate probing to the sidecar.

### 5. Provider routing

`getActiveProvider(mode?)` should continue returning a composite provider for transcription and cleanup.

Selection rules:

- Existing Whisper and Parakeet behavior remains unchanged.
- GGUF ASR is only selected when a mode or global setting explicitly selects a GGUF catalogue entry.
- Cleanup provider selection remains independent.
- If a GGUF model fails compatibility checks, the UI must block selection or show a clear actionable error.

### 6. UI catalogue behavior

The model catalogue UI should group models by engine and architecture.

Suggested grouping:

- Recommended
- Whisper
- Parakeet
- Experimental multi-architecture GGUF
- Bring-your-own local model

Each model card should show:

- Model name
- Architecture
- Engine/runtime
- Download size
- Capabilities
- Experimental badge if applicable
- Platform support
- Installation status
- Compatibility/probe status

GGUF models should be clearly labeled experimental until runtime stability and packaging are proven.

## Security and Privacy

### Sidecar execution

- Only execute sidecars from Verbatim-managed install locations.
- Verify sidecar SHA-256 before execution.
- Verify downloaded model SHA-256 before use.
- Do not execute arbitrary model-provided scripts or metadata.
- Avoid shell interpolation; invoke binaries with structured argument arrays.
- Keep model paths normalized and scoped to the app-managed model directory unless explicitly supporting BYO model import.
- For BYO imports, validate extension, readable file type, and GGUF metadata before use.

### Network and downloads

- Use HTTPS download URLs.
- Store expected checksums in catalogue metadata.
- Fail closed on checksum mismatch.
- Surface checksum failures to the user.
- Do not silently retry from untrusted mirrors.

### Privacy

- Local GGUF transcription must remain local.
- Do not upload audio, transcript text, model metadata, or local file paths during local transcription.
- Logs must not include transcript content, full audio paths, auth tokens, Supabase keys, or user PII.
- Error messages may include model id and architecture but should avoid absolute paths where possible.

### Process isolation

- Sidecar process should run with the narrowest practical permissions.
- Sidecar lifecycle should be explicit and observable.
- Crashes should not crash the Tauri app.
- Hung sidecars should time out and surface a recoverable error.

## Testing Strategy

### Unit tests

Cover:

- Catalogue metadata parsing.
- Engine/architecture compatibility rules.
- Capability merge/probe behavior.
- Provider routing when a mode selects:
  - Whisper
  - Parakeet
  - GGUF ASR
  - invalid/unavailable model
- Error mapping for:
  - missing sidecar
  - checksum mismatch
  - unsupported architecture
  - sidecar timeout
  - malformed probe result

### Rust tests

Cover command-level behavior where practical:

- Sidecar path resolution.
- Download metadata validation.
- Checksum verification.
- Argument construction without shell interpolation.
- GGUF probe command parsing.
- Timeout/error propagation.

### Integration tests

Cover:

- Selecting a GGUF catalogue model does not affect Whisper/Parakeet defaults.
- Installed GGUF runtime can transcribe a short fixture audio file.
- Unsupported GGUF architecture is rejected before transcription.
- Corrupt model file is rejected by checksum/probe.
- Sidecar crash returns a structured provider error.

### Manual QA

Run these checks on supported platforms before release:

- macOS Apple Silicon.
- macOS Intel if supported.
- Windows x64.
- Linux x64 if release artifacts exist.

Manual scenarios:

1. Fresh install with no GGUF runtime.
2. Download GGUF runtime.
3. Download a supported GGUF ASR model.
4. Probe model capabilities.
5. Select model in a mode.
6. Record audio from overlay.
7. Confirm transcript appears and paste flow still works.
8. Switch back to Whisper and confirm prior behavior.
9. Remove/corrupt model and confirm UI shows recoverable error.
10. Disable network and confirm installed models still work.

## Commands

Reference commands for implementation validation:

```bash
pnpm install
pnpm lint
pnpm build
pnpm tauri dev
pnpm tauri build
```

Targeted tests should be added to the existing test framework if present. If no dedicated test runner exists for a layer, validate with the smallest available build/lint command and manual runtime checks.

## Screenshots

Implementation PRs should include screenshots or short screen recordings for:

1. Model catalogue showing the new GGUF/multi-architecture section.
2. A GGUF model card with architecture, capabilities, and experimental status.
3. Runtime/model download state.
4. Compatibility/probe success state.
5. Compatibility/probe failure state.
6. Mode settings showing a selected GGUF model.
7. Successful overlay transcription using a GGUF model.

Screenshots must not include real user transcripts, names, emails, or other PII. Use synthetic test text/audio only.

## Acceptance Criteria

- A new GGUF multi-architecture ASR engine path is represented in the catalogue and provider architecture.
- The implementation uses an external sidecar process only; no in-process GGUF or `whisper.cpp` linking is introduced.
- Whisper and Parakeet remain the defaults and continue working without configuration changes.
- GGUF support is opt-in and clearly marked experimental where appropriate.
- Catalogue entries include engine, architecture, model format, platform support, download metadata, checksum, and capabilities.
- GGUF metadata probing validates architecture compatibility before transcription.
- Unsupported or unprobeable models fail with clear user-facing errors.
- Runtime and model downloads are checksum-verified.
- Sidecar execution avoids shell interpolation and does not execute arbitrary model metadata.
- Local transcription data remains local and is not uploaded.
- UI exposes model architecture, capabilities, installation state, and compatibility state.
- Existing recording, cleanup, and paste flow continue to work with current providers.
- Tests cover provider routing, catalogue compatibility, checksum failure, unsupported architecture, and sidecar/probe error handling.
- Release packaging plan accounts for sidecar binaries per supported platform and GPU/CPU variant.

## Open Design Questions

- Which GGUF ASR runtime should be standardized first: a `transcribe-cpp`-style server, one-shot CLI, or architecture-specific ONNX fallback through `sherpa-onnx`?
- Which platforms receive first-class sidecar artifacts for the initial release?
- Should GGUF support initially ship hidden behind an experimental setting, or simply as an opt-in catalogue section?
- What minimum model set proves the architecture without over-expanding release risk?
- Should BYO GGUF imports be included in the first implementation or deferred until curated catalogue models are stable?
- What capability fields can be reliably probed from current GGUF ASR metadata versus maintained manually in catalogue data?

## Boundaries

- Always:
  - Preserve existing Whisper and Parakeet behavior.
  - Verify downloaded binaries and models by checksum.
  - Keep local audio/transcript data local.
  - Surface sidecar/model failures explicitly.
  - Use structured process invocation.
- Ask first:
  - Adding new runtime dependencies.
  - Changing release pipeline or CI artifact publishing.
  - Enabling GGUF models by default.
  - Expanding BYO model import scope.
- Never:
  - Link GGUF or `whisper.cpp` in-process.
  - Execute untrusted model metadata.
  - Commit secrets or model binaries to source.
  - Silently fall back to a different ASR model without telling the user.
  - Log transcript content, audio contents, auth tokens, or sensitive local paths.
```
