<!-- verbatim-ai:artifact:v1 issue=40 phase=spec id=issue-0040-issue-0040-0a2238bd-1e75-4bdb-b243-8f7fa517d6cd-SPEC-006 display=SPEC-006 run=issue-0040-0a2238bd-1e75-4bdb-b243-8f7fa517d6cd -->
# SPEC-006: Architect spec

- Issue: #40
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0040-issue-0040-0a2238bd-1e75-4bdb-b243-8f7fa517d6cd-SPEC-006
- Agent: architect
- Run: issue-0040-0a2238bd-1e75-4bdb-b243-8f7fa517d6cd
- Created: 2026-07-25T04:36:56.758Z

## Summary

Spec

## Body

# Spec

● skill(doc-coauthoring)

Below is proposed content for `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md`.

```markdown
# Spec: Issue 0040 - Full Multi-Architecture Model Catalogue via GGUF Sidecar Engine

## Objective

Expand Verbatim AI’s local/offline ASR model breadth beyond the current Whisper GGML and Parakeet ONNX paths by designing an opt-in multi-architecture GGUF sidecar engine and catalogue extension.

The goal is Handy-parity model breadth in architecture, not necessarily immediate parity in every shipped model. Verbatim should be able to describe, discover, download, probe, and run models across additional ASR architectures such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and similar GGUF-compatible architectures, while preserving the existing non-regressive defaults.

Success means:

- Existing Whisper and Parakeet behavior remains unchanged by default.
- No in-process whisper.cpp, GGUF, or transcribe-cpp linking is introduced.
- New multi-architecture support is implemented through downloaded sidecar binaries.
- The model catalogue can represent architecture, engine, artifact format, platform support, and runtime capabilities.
- Capability metadata can be statically declared and, where supported, probed from GGUF metadata or a sidecar probe command.
- Release/build automation has a clear path for bundling or downloading the new sidecar per OS/CPU/GPU variant.

## Problem

Verbatim AI currently has a data-driven local model catalogue and supports local ASR through a small number of runtime families:

- Whisper-compatible GGML models.
- Parakeet / sherpa-onnx models.
- Cleanup through local or cloud LLM providers.

This does not cover the breadth of ASR architectures available in Handy-style catalogues, where many architecture families are loaded through a single GGUF multi-architecture engine. Verbatim previously avoided in-process whisper.cpp-style linking because Windows builds hit bindgen/libclang version mismatch issues. A correct design must preserve that constraint and keep native inference engines outside the Tauri process.

## Current Repo Facts

Based on the repository architecture:

- Verbatim AI is a Tauri 2 desktop app with:
  - Rust backend in `src-tauri/`.
  - React/TypeScript frontend in `src/`.
  - Main settings window and separate overlay window.
- Local transcription providers currently include:
  - `src/lib/ai/localWhisper.ts`
  - `src/lib/ai/parakeet.ts`
  - `src/lib/ai/ollama.ts` for cleanup only
  - `src/lib/ai/index.ts` for provider composition.
- Rust sidecar-related commands currently live under `src-tauri/src/commands/`, including local Whisper and Parakeet management commands.
- App state uses Zustand stores under `src/lib/store/`, with localStorage caches using `sw.*` keys so the overlay can read synchronously.
- The recording pipeline is:
  1. Global hotkey from Rust.
  2. Main window resolves active mode.
  3. Overlay records audio.
  4. Active AI provider transcribes and optionally cleans text.
  5. Rust pastes text back to the target app.
- Existing defaults must remain Whisper / Parakeet and cloud paths, depending on the user’s current settings.
- Styling must use tokens from `src/styles/tokens.css`.

Implementation must verify the exact current catalogue files from the issue #31 work before editing, but this spec assumes there is already a data-driven model catalogue abstraction that can be extended rather than replaced.

## Non-Goals

- Do not introduce in-process whisper.cpp, GGUF, transcribe-cpp, or equivalent native library linking.
- Do not replace Whisper or Parakeet as defaults.
- Do not require all Handy models to be shipped in the first implementation.
- Do not require every architecture to support streaming, translation, or language detection.
- Do not silently enable experimental models for users who have not opted in.
- Do not store raw model files, probe dumps, absolute paths, or user environment details in telemetry or logs.

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript + Vite
- State: Zustand
- Styling: Tailwind mapped to CSS custom properties
- Local ASR sidecars:
  - Existing Whisper sidecar path
  - Existing Parakeet / sherpa-onnx path
  - New GGUF multi-architecture sidecar path
- Model metadata:
  - Existing data-driven catalogue format
  - Extended static metadata plus optional runtime probing

## Commands

Use existing repository commands only:

```bash
pnpm install
pnpm build
pnpm lint
pnpm tauri dev
pnpm tauri build
```

Targeted validation should prefer the smallest available command that covers the change. For frontend catalogue/provider changes, start with:

```bash
pnpm build
pnpm lint
```

For Rust/Tauri command changes, also run the relevant Tauri build/check command available in the repository. If no narrower Rust command exists, use:

```bash
pnpm tauri build
```

## Proposed Architecture

### 1. Add a Multi-Architecture GGUF Engine as a Sidecar

Introduce a new local ASR engine family, tentatively named `gguf-multiarch`, implemented as a sidecar process. The sidecar should expose a stable CLI or server contract similar in spirit to existing local Whisper / Parakeet sidecars.

Required sidecar capabilities:

```text
probe <model-path>
transcribe <model-path> <audio-path> [options]
version
```

Preferred server form, if available:

```text
serve --host 127.0.0.1 --port <ephemeral> --model <model-path>
POST /v1/audio/transcriptions
GET /health
GET /model/capabilities
```

The implementation should select CLI mode or server mode based on the chosen upstream engine’s maturity. Server mode is preferred if model load time is high and persistent processes are reliable. CLI mode is acceptable for an initial implementation if simpler and stable.

The Tauri process manages the sidecar lifecycle but does not link against native model code.

### 2. Extend the Catalogue Schema

Extend the model catalogue entries to describe runtime compatibility instead of assuming one local engine per format.

Suggested model shape:

```ts
type LocalAsrEngine =
  | "whisper-ggml"
  | "parakeet-onnx"
  | "gguf-multiarch";

type ModelArchitecture =
  | "whisper"
  | "parakeet"
  | "canary"
  | "voxtral"
  | "qwen3-asr"
  | "moonshine"
  | "gigaam"
  | "granite-speech"
  | "sensevoice"
  | "unknown";

type ModelCapability = {
  transcription: boolean;
  streaming: boolean;
  translation: boolean;
  languageDetection: boolean;
  timestamps: boolean;
  diarization?: boolean;
  supportedLanguages?: string[];
  probed?: boolean;
  probeSource?: "static-catalogue" | "gguf-metadata" | "sidecar";
};

type CatalogueModel = {
  id: string;
  displayName: string;
  architecture: ModelArchitecture;
  engine: LocalAsrEngine;
  artifactFormat: "ggml" | "gguf" | "onnx" | "other";
  sizeBytes?: number;
  quantization?: string;
  recommendedTier?: "tiny" | "small" | "medium" | "large";
  capabilities: ModelCapability;
  artifacts: {
    platform?: "darwin" | "windows" | "linux" | "all";
    arch?: "x64" | "arm64" | "universal";
    url: string;
    sha256: string;
  }[];
  runtime: {
    requiresSidecar: boolean;
    sidecarId?: string;
    minSidecarVersion?: string;
    gpuVariants?: Array<"cpu" | "metal" | "cuda" | "directml">;
  };
};
```

Exact names should match existing catalogue conventions after inspection. The key requirement is that architecture, engine, format, capabilities, and artifact/runtime compatibility are explicit and testable.

### 3. Add GGUF Capability Probing

Capability probing should be additive and safe.

The probing flow:

1. Read static catalogue metadata.
2. If the model is local and the selected engine supports probing, call the sidecar probe command.
3. Parse only whitelisted capability fields from the probe result.
4. Merge probed values into the runtime model view.
5. Cache the normalized capability result with the model version/hash.
6. Never persist raw probe output.

Probe output should be normalized into a small allowlist:

```json
{
  "architecture": "sensevoice",
  "supportedLanguages": ["en", "es", "fr"],
  "streaming": false,
  "translation": false,
  "languageDetection": true,
  "timestamps": true
}
```

Unknown metadata must not become user-visible configuration automatically. If the sidecar reports unsupported or unknown fields, they should be ignored unless explicitly mapped.

### 4. Provider Integration

Add a new local provider implementation, tentatively:

```text
src/lib/ai/ggufMultiarch.ts
```

Responsibilities:

- Validate the selected model is compatible with `gguf-multiarch`.
- Ensure the sidecar is installed or report actionable setup status.
- Send audio to the Rust command / sidecar bridge.
- Return the same transcription result shape expected by `AIProvider`.
- Surface capability limitations to the UI.

The provider should integrate through `getActiveProvider(mode?)` without changing existing provider contracts unless necessary. If the existing contract cannot represent capabilities cleanly, introduce a small shared capability type rather than adding provider-specific conditionals throughout the UI.

### 5. Rust Sidecar Management

Add Rust command support under `src-tauri/src/commands/`, following existing local Whisper / Parakeet sidecar patterns.

Likely commands:

```text
gguf_engine_status
gguf_engine_download
gguf_engine_probe_model
gguf_engine_transcribe
gguf_engine_cancel
```

Exact names should follow existing command naming conventions.

Responsibilities:

- Resolve sidecar install path.
- Download the correct sidecar for platform / architecture / GPU variant.
- Verify SHA-256 checksums before execution.
- Mark binaries executable on Unix/macOS.
- Launch only known binaries from managed paths.
- Pass arguments without shell interpolation.
- Enforce timeouts and cancellation.
- Return structured errors.

### 6. UI / UX

The model catalogue UI should show additional model families only when the feature is available or explicitly enabled.

Recommended UX:

- Existing users continue seeing current defaults.
- Experimental multi-architecture models appear behind an “Advanced”, “Experimental”, or “Additional local models” affordance.
- Each model card should show:
  - Architecture
  - Engine
  - Download size
  - Quantization
  - Capabilities
  - Platform/GPU support
  - Any limitations, such as no streaming or no translation
- If a model requires the GGUF sidecar, the UI should show:
  - Install/download sidecar action
  - Sidecar version/status
  - Model compatibility status
- Unsupported models should be visible only if useful, and clearly disabled with an explanation.

Screens should continue using existing design tokens.

### 7. Release Pipeline

The release pipeline must account for sidecar distribution.

Required decisions before implementation:

- Whether the GGUF sidecar is bundled into app releases or downloaded on demand.
- Which platforms are supported initially:
  - macOS arm64
  - macOS x64
  - Windows x64
  - Linux x64, if supported by the app
- Which acceleration variants are supported initially:
  - CPU
  - Metal
  - CUDA
  - DirectML
- Where sidecar manifest metadata lives.
- How checksums and versions are updated.

Preferred initial approach:

- Download sidecar on demand, consistent with existing local runtime management.
- Keep app installer size stable.
- Use a signed/versioned manifest containing URL, platform, arch, variant, version, and SHA-256.
- Fail closed if the manifest entry is missing or checksum validation fails.

## Security and Privacy

### Sidecar Execution

- Never execute sidecar commands through a shell.
- Use explicit argv arrays.
- Execute only binaries installed under Verbatim-managed runtime directories.
- Verify checksums before first use and after updates.
- Do not trust model metadata as executable input.
- Do not allow model paths to select arbitrary executables.

### Downloads

- Use HTTPS-only download URLs.
- Pin SHA-256 checksums in a manifest.
- Surface checksum/download failures explicitly.
- Do not auto-update sidecars silently while transcription is active.
- Do not execute partially downloaded files.

### Metadata Probing

- Treat GGUF metadata and sidecar probe output as untrusted.
- Parse only a strict allowlist of known fields.
- Ignore unknown fields.
- Do not log raw metadata dumps.
- Do not persist absolute user paths in telemetry or app-visible diagnostics.
- Avoid including model file paths in user-facing errors unless already consistent with existing local model UX.

### Privacy

- Local ASR models must not upload audio.
- If cleanup is configured to use cloud services, existing disclosure/behavior should remain unchanged.
- UI should distinguish local transcription from cloud cleanup where the app already does so.
- Do not add telemetry containing model names, file paths, audio paths, or probe dumps unless there is an existing privacy-reviewed pattern.

### Resource Safety

- Enforce maximum concurrent local transcriptions per engine.
- Support cancellation.
- Clean up temporary audio files according to existing recording pipeline behavior.
- Bound sidecar startup/probe/transcription timeouts.
- Surface out-of-memory or unsupported-hardware errors clearly.

## Testing Strategy

### Unit Tests

Add or update tests for:

- Catalogue schema parsing.
- Model filtering by engine, architecture, platform, and capability.
- Static capability rendering.
- Probe result normalization.
- Unknown probe fields being ignored.
- Invalid or missing sidecar manifest entries.
- Provider selection when a mode chooses a GGUF model.
- Fallback behavior when GGUF sidecar is unavailable.

### Rust Tests

Add tests where existing Rust command tests are present, covering:

- Sidecar path resolution.
- Manifest selection by platform/arch/variant.
- Checksum validation.
- Probe output parsing.
- Argument construction without shell invocation.
- Error mapping for missing sidecar, unsupported model, timeout, and failed process.

### Integration Tests

Add integration coverage for:

- Selecting a GGUF catalogue model.
- Installing or detecting the sidecar.
- Probing capabilities for a local model.
- Transcribing a short fixture audio file through the new provider.
- Ensuring Whisper and Parakeet selections still work.

If real GGUF test models are too large, use a mocked sidecar fixture for CI and reserve real-model validation for manual/release testing.

### Regression Tests

Must confirm:

- Existing Whisper local transcription path is unchanged.
- Existing Parakeet local transcription path is unchanged.
- Existing cloud/Supabase provider path is unchanged.
- Existing mode override behavior still resolves providers correctly.
- Overlay recording flow does not need new network or auth state to use existing defaults.

### Manual Test Matrix

At minimum:

| Scenario | Expected Result |
|---|---|
| Existing user launches app after upgrade | Existing provider/model selection remains unchanged |
| User opens model catalogue | Current models still display correctly |
| User enables advanced multi-arch catalogue | GGUF models appear with architecture/capability badges |
| User selects unsupported platform model | Selection is blocked with a clear reason |
| User downloads sidecar | Checksum is verified before use |
| User probes GGUF model | Capabilities render from normalized metadata |
| Probe fails | Static metadata remains, with an explicit warning |
| Transcription succeeds | Text flows through existing cleanup/paste pipeline |
| Sidecar times out | User sees actionable error and app remains responsive |
| Existing Whisper transcription | Still succeeds |
| Existing Parakeet transcription | Still succeeds |

## Screenshots

Capture screenshots for any UI changes introduced by this work.

Required screenshots:

1. Model catalogue before enabling additional GGUF / multi-architecture models.
2. Model catalogue after enabling advanced multi-architecture models.
3. A model detail/card showing:
   - Architecture
   - Engine
   - Quantization
   - Capabilities
   - Platform/GPU support
4. Sidecar missing/install required state.
5. Sidecar installed/ready state.
6. Unsupported model/platform disabled state.
7. Probe failure warning state.
8. Successful selected GGUF model state in settings.
9. Existing Whisper or Parakeet default state after upgrade, proving non-regression.

Screenshots must not include personal data, local absolute paths, emails, usernames, API keys, or real audio transcript content.

## Code Style

Follow existing repository conventions. Prefer typed discriminated unions over loose strings where model/runtime families branch behavior.

Example style:

```ts
type EngineAvailability =
  | { status: "ready"; version: string }
  | { status: "missing"; installAction: "download" }
  | { status: "unsupported"; reason: string }
  | { status: "error"; message: string };

function isModelRunnable(model: CatalogueModel, engine: EngineAvailability): boolean {
  return model.runtime.requiresSidecar
    ? engine.status === "ready"
    : engine.status !== "unsupported";
}
```

Guidelines:

- Keep engine-specific code isolated to provider/sidecar modules.
- Keep UI components data-driven from catalogue/capability metadata.
- Do not scatter architecture-name conditionals across unrelated UI.
- Prefer explicit error states over silent fallback.
- Reuse existing download, sidecar, provider, and store patterns where available.

## Boundaries

### Always Do

- Preserve existing defaults.
- Keep GGUF/multi-architecture support opt-in or clearly advanced.
- Use sidecar process isolation.
- Verify downloaded binaries with checksums.
- Treat model metadata as untrusted input.
- Add regression tests for Whisper and Parakeet provider selection.
- Use existing design tokens for UI.

### Ask First

- Adding a new third-party native runtime dependency.
- Changing CI/release signing behavior.
- Bundling large sidecar binaries directly into app installers.
- Changing the public provider contract in a way that affects all providers.
- Adding telemetry for model selection, model metadata, or local runtime status.
- Removing or renaming existing catalogue fields.

### Never Do

- Link GGUF/whisper.cpp/transcribe-cpp in-process.
- Execute downloaded binaries before checksum verification.
- Invoke sidecars through shell-expanded command strings.
- Upload local audio for a model selected as local-only transcription.
- Persist raw GGUF metadata, raw probe dumps, secrets, absolute paths, or environment variables.
- Make experimental models the default for existing users.

## Implementation Plan

### Phase 1 - Discovery and Design Validation

- Inspect the existing catalogue implementation from issue #31.
- Identify current model schema, provider selection logic, sidecar command patterns, and UI surfaces.
- Choose initial sidecar strategy:
  - GGUF multi-architecture sidecar server, if mature enough.
  - CLI sidecar wrapper, if server mode is not stable.
  - sherpa-onnx per-architecture fallback only if GGUF sidecar is not feasible.
- Document supported initial platforms and variants.

Exit criteria:

- Existing catalogue extension points are known.
- Sidecar contract is chosen.
- Initial model subset is selected.

### Phase 2 - Catalogue Schema Extension

- Extend model metadata types.
- Add architecture/engine/capability fields.
- Add feature-gated or advanced GGUF catalogue entries.
- Add unit tests for model parsing/filtering.

Exit criteria:

- Catalogue can represent current and future models without special-case UI logic.
- Existing models still parse.

### Phase 3 - Sidecar Manager

- Add Rust commands for sidecar status, download, probe, and transcription.
- Add manifest support for platform/arch/variant selection.
- Add checksum validation.
- Add process timeout/cancellation behavior.
- Add tests for path, manifest, checksum, and error mapping.

Exit criteria:

- Sidecar can be installed/detected safely.
- Probe/transcribe command contract is available to frontend.

### Phase 4 - Provider Integration

- Add `gguf-multiarch` provider.
- Wire provider selection into existing `getActiveProvider(mode?)`.
- Normalize transcription results to existing `AIProvider` output.
- Preserve cleanup/paste pipeline behavior.

Exit criteria:

- A selected GGUF model can transcribe through the same app flow as existing providers.
- Existing providers remain unchanged.

### Phase 5 - UI Integration

- Update catalogue UI to show architecture, engine, and capabilities.
- Add sidecar install/status states.
- Add unsupported platform/model states.
- Add probe status and warnings.
- Capture required screenshots.

Exit criteria:

- Users can understand model compatibility before selection.
- Experimental models do not disrupt default UX.

### Phase 6 - Release and Validation

- Add or update release manifest generation.
- Document sidecar distribution/update process.
- Run build/lint/tests.
- Run manual test matrix.
- Confirm screenshots are redacted and complete.

Exit criteria:

- Feature is shippable behind its intended opt-in/advanced surface.
- Release process can distribute the required sidecar artifacts.

## Acceptance Criteria

### Functional

- Existing Whisper and Parakeet defaults remain unchanged after upgrade.
- Catalogue entries can represent at least one additional GGUF ASR architecture.
- GGUF/multi-architecture entries include architecture, engine, format, capabilities, artifacts, and runtime requirements.
- User can install or detect the GGUF sidecar from the app.
- Sidecar checksum validation is required before execution.
- User can probe a compatible local GGUF model for capabilities.
- Probe results are normalized into a safe allowlisted capability shape.
- User can select a compatible GGUF model and run transcription through the existing recording pipeline.
- Unsupported models/platforms are disabled or clearly explained.
- Probe/transcription failures surface actionable errors without breaking the app.

### Non-Regression

- Existing Whisper local transcription still works.
- Existing Parakeet local transcription still works.
- Existing Supabase/cloud transcription still works.
- Existing cleanup provider selection still works.
- Existing mode-specific provider overrides still work.
- Overlay recording and paste flow still works for existing providers.

### Security

- No in-process GGUF/whisper.cpp/transcribe-cpp linking is introduced.
- No shell invocation is used for sidecar execution.
- Downloaded binaries are checksum-verified before execution.
- Raw GGUF metadata/probe output is not persisted or logged.
- Local audio is not uploaded when local transcription is selected.
- Absolute local paths are not exposed in screenshots, telemetry, or unnecessary logs.

### Testing

- Catalogue schema/filtering tests cover existing and GGUF models.
- Probe normalization tests cover known, unknown, malformed, and missing fields.
- Sidecar manifest/checksum tests cover success and failure.
- Provider selection tests cover default, mode override, missing sidecar, and unsupported model.
- At least one mocked-sidecar integration test covers successful transcription.
- Manual screenshots cover the required states.

## Open Questions

1. Which upstream GGUF multi-architecture sidecar should be used first?
2. Should the first implementation use persistent server mode or one-shot CLI mode?
3. Which architectures are included in the initial model subset?
4. Which platforms and GPU variants are supported at launch?
5. Should GGUF models be hidden behind a feature flag, an advanced setting, or both?
6. Where should the sidecar manifest be hosted and how should it be updated?
7. What is the maximum acceptable model download size for catalogue-listed models?
8. Should probe results be cached per model file hash, catalogue version, or both?
9. Should BYO GGUF models be supported in the first implementation or only curated catalogue models?
10. What manual release validation hardware is available for Windows/macOS/Linux GPU variants?
```

