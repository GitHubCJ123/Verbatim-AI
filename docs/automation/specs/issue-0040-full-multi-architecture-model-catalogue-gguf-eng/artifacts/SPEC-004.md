<!-- verbatim-ai:artifact:v1 issue=40 phase=spec id=issue-0040-issue-0040-f84b3e4c-e459-446b-ad8a-a0176ddafd7b-SPEC-004 display=SPEC-004 run=issue-0040-f84b3e4c-e459-446b-ad8a-a0176ddafd7b -->
# SPEC-004: Architect spec

- Issue: #40
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0040-issue-0040-f84b3e4c-e459-446b-ad8a-a0176ddafd7b-SPEC-004
- Agent: architect
- Run: issue-0040-f84b3e4c-e459-446b-ad8a-a0176ddafd7b
- Created: 2026-07-24T20:20:48.168Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue #40 — Full Multi-Architecture Model Catalogue via GGUF Sidecar Engine

## Objective

Verbatim AI currently supports a data-driven model catalogue, bring-your-own GGML discovery, Whisper GGML models, and Parakeet ONNX models, but it does not yet support the broader ASR architecture range available in Handy-style catalogues such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and similar families.

This feature designs an opt-in, non-regressive path to add a multi-architecture model catalogue by introducing a sidecar-based GGUF or equivalent multi-architecture runtime. The goal is to expand model breadth without reintroducing in-process `whisper.cpp`/GGUF linking risks, especially on Windows.

Success means Verbatim can catalogue and run multiple ASR architectures through a sidecar engine, expose accurate model capabilities from metadata/probing, preserve Whisper and Parakeet as safe defaults, and package/runtime-manage the new engine consistently across supported platforms.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with a React/TypeScript frontend and Rust backend.

Relevant current architecture:

- Frontend app code lives under `src/`.
- Tauri backend code lives under `src-tauri/`.
- Main settings UI is served through the `main` Tauri window.
- Recording overlay is served through the `overlay` Tauri window from `overlay.html` and `src/overlay/`.
- Recording starts from Rust global shortcut events, flows through `src/lib/hotkey.ts`, `src/lib/modeResolver.ts`, and `src/lib/recording-bridge.ts`, then audio capture happens in `src/overlay/Overlay.tsx`.
- AI provider selection is centralized around `src/lib/ai/index.ts` and the `AIProvider` abstraction in `src/lib/ai/AIProvider.ts`.
- Existing providers include:
  - `SupabaseAIProvider` for cloud/local Supabase Edge Function transcription and cleanup.
  - `LocalWhisperProvider` for local `whisper-cli` sidecar transcription.
  - `ParakeetProvider` for local `sherpa-onnx` sidecar transcription.
  - `OllamaProvider` for local cleanup only.
- Local sidecar management already exists in Rust commands:
  - `src-tauri/src/commands/local_whisper.rs`
  - `src-tauri/src/commands/parakeet.rs`
- App mode is stored in `src/lib/appMode.ts` using localStorage key `sw.app.mode`.
- Zustand stores under `src/lib/store/` persist data to localStorage using `sw.*` keys so the overlay can read synchronously.
- Styling uses CSS variables from `src/styles/tokens.css`; new UI must use those tokens.

## Assumptions

1. The implementation should remain sidecar-only for new GGUF/multi-architecture ASR engines.
2. Whisper and Parakeet remain existing stable/default local transcription options.
3. The first implementation may support a limited initial model set as long as the catalogue schema supports future families.
4. The catalogue should be data-driven rather than hardcoded into provider control flow.
5. Capability data should come from model metadata/probing where possible, with conservative curated fallbacks where metadata is absent.
6. GPU/runtime variants may be handled incrementally, but the architecture must not block platform-specific variants later.

## Tech Stack

- Desktop shell: Tauri 2
- Backend: Rust
- Frontend: React + TypeScript
- State: Zustand + localStorage cache
- Build tooling: pnpm, Vite, Tauri CLI
- Existing local ASR sidecars:
  - Whisper GGML via `whisper-cli` / related local Whisper runtime
  - Parakeet via `sherpa-onnx`
- Proposed new runtime:
  - Preferred: prebuilt sidecar process exposing a stable CLI or local server API for GGUF multi-architecture transcription.
  - Acceptable alternative: per-architecture ONNX runtime support through `sherpa-onnx` only if it can cover the desired breadth without fragmenting the provider model.

## Commands

Primary validation commands:

```bash
pnpm build
pnpm lint
pnpm tauri build
```

Development commands:

```bash
pnpm dev
pnpm tauri dev
```

Rust-focused validation, if backend command changes are substantial:

```bash
cd src-tauri && cargo test
cd src-tauri && cargo check
```

Supabase commands are not expected for this feature unless catalogue data is moved into Supabase-managed configuration:

```bash
supabase db push
supabase functions deploy transcribe --no-verify-jwt
```

## Project Structure

Expected areas touched by implementation:

```text
src/lib/ai/
  AIProvider.ts              Existing provider contract
  index.ts                   Active/composite provider selection
  localWhisper.ts            Existing local Whisper provider reference point
  parakeet.ts                Existing Parakeet provider reference point
  ggufMultiArch.ts           New frontend provider wrapper for GGUF sidecar

src/lib/store/
  ...                        Existing settings/model catalogue state

src-tauri/src/commands/
  local_whisper.rs           Existing sidecar lifecycle pattern
  parakeet.rs                Existing sidecar lifecycle pattern
  gguf_multi_arch.rs         New sidecar download/probe/transcribe commands

src-tauri/src/
  main.rs or command registry files
                             Register new Tauri commands

docs/automation/specs/
  issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md

src/
  Model/provider settings UI, if catalogue selection is user-visible

src-tauri/
  Platform bundle config and sidecar packaging metadata
```

Exact file names may vary to match existing repository conventions.

## Code Style

Use typed, data-driven provider definitions rather than provider-specific conditionals spread across the app.

Example target style:

```ts
export type AsrArchitecture =
  | "whisper"
  | "parakeet"
  | "canary"
  | "voxtral"
  | "qwen3-asr"
  | "moonshine"
  | "gigaam"
  | "granite"
  | "sensevoice";

export interface LocalAsrModelDescriptor {
  id: string;
  label: string;
  architecture: AsrArchitecture;
  engine: "whisper-ggml" | "parakeet-onnx" | "gguf-multi-arch";
  source: "bundled" | "downloadable" | "user";
  capabilities: {
    languages?: string[];
    streaming: boolean;
    translation: boolean;
    languageDetection: boolean;
  };
}
```

Conventions:

- Keep architecture/model descriptors serializable so they can be cached in localStorage for overlay use.
- Prefer explicit capability fields over inference in UI components.
- Do not use `as any` to bypass catalogue/provider type mismatches.
- Preserve existing provider behavior unless the selected model explicitly uses the new engine.
- Surface sidecar failures as actionable errors rather than silent fallbacks that make users think a selected model ran when it did not.

## Architecture

### High-Level Design

Add a new local ASR engine family named conceptually `gguf-multi-arch`, implemented as an external sidecar process. The sidecar is responsible for loading GGUF models, detecting the architecture from model metadata/header information, and performing transcription through a CLI or local server API.

The Verbatim app should not link in-process against `whisper.cpp`, GGUF loaders, or architecture-specific C++ libraries.

### Provider Flow

1. User selects a model from the expanded catalogue.
2. The selected model descriptor includes:
   - model id
   - architecture
   - engine type
   - download/runtime metadata
   - capability metadata
3. `getActiveProvider(mode?)` chooses the correct transcription provider based on model/Mode settings.
4. For GGUF multi-architecture models, the frontend provider calls a Tauri command.
5. Rust command ensures the sidecar exists, validates the model path, probes metadata if needed, and invokes the sidecar.
6. Sidecar returns transcription output in a stable structured format.
7. Existing cleanup provider selection remains unchanged.

### Catalogue Model

The catalogue should support:

- Multiple ASR architectures.
- Multiple runtime engines.
- Per-model capability metadata:
  - supported languages
  - streaming support
  - translation support
  - language detection support
  - expected input format
  - quantization/runtime requirements
- Runtime availability:
  - downloadable sidecar availability by platform
  - CPU/GPU variant support
  - model download status
  - user-provided model path support
- Metadata provenance:
  - probed from GGUF metadata
  - curated fallback
  - user-provided/unknown

### Capability Probing

The implementation should probe GGUF metadata before presenting advanced capabilities as available.

Expected behavior:

- If language metadata is present, use it.
- If architecture metadata is present, map it to a known `AsrArchitecture`.
- If metadata is missing or unrecognized, show conservative capabilities.
- Unknown models should not claim streaming, translation, or language detection unless verified.
- Probe failures should be visible in diagnostics/settings UI and should not crash recording.

### Sidecar Runtime

The GGUF sidecar should follow existing local sidecar patterns:

- Downloaded as a prebuilt runtime binary, not compiled by the app.
- Stored in the same app-managed sidecar area as existing local engines.
- Versioned explicitly.
- Checksummed before execution.
- Invoked with explicit arguments, not shell-concatenated command strings.
- Has a stable JSON or line-delimited output format if possible.
- Supports cancellation/timeouts for long transcription jobs.
- Does not receive secrets or unrelated app state.

### Defaults and Rollout

This feature is opt-in.

- Existing Whisper and Parakeet flows remain default and unchanged.
- Existing modes continue to resolve to their current providers unless explicitly changed.
- New models appear as unavailable until their runtime and model files are installed.
- Experimental labels should be used for architectures whose runtime behavior is not yet production-grade.

## Security and Privacy

Security requirements:

- No in-process GGUF/`whisper.cpp` linking.
- Never execute user-provided shell strings.
- Invoke sidecars with structured process APIs and escaped/validated arguments.
- Validate model paths:
  - must point to expected model file types
  - must not traverse into protected locations unexpectedly
  - must not be treated as executable code
- Verify downloaded sidecar checksums/signatures where available.
- Do not log raw audio, transcripts, auth tokens, Supabase credentials, environment variables, or absolute private paths in telemetry/debug output.
- Redact sensitive file paths in user-facing diagnostics where feasible.
- Keep local transcription local; do not route audio to cloud providers unless the selected provider requires it and the user has opted into that path.
- Capability probing must read model metadata only and must not execute model-supplied scripts or dynamic code.
- Sidecar crashes should not compromise the main app process.
- GPU/runtime selection must not load untrusted dynamic libraries from arbitrary user paths.

Privacy requirements:

- Audio remains local for local GGUF models.
- Transcripts are handled through the same existing post-processing path as other local providers.
- No catalogue probe should upload model metadata externally.
- Logs should identify model ids/architectures, not user transcript content.

## Testing Strategy

### Unit Tests

Add TypeScript tests where existing test infrastructure supports them for:

- Catalogue schema parsing.
- Architecture-to-engine routing.
- Capability fallback behavior.
- Provider selection preserving existing Whisper/Parakeet defaults.
- Mode override behavior with new model descriptors.

Add Rust tests where practical for:

- Sidecar path validation.
- Sidecar command argument construction.
- Metadata probe parsing.
- Error mapping from sidecar failures to Tauri command errors.

### Integration Tests

Cover:

- Selecting an existing Whisper model still uses the existing Whisper provider.
- Selecting an existing Parakeet model still uses the existing Parakeet provider.
- Selecting a GGUF multi-architecture model routes to the new sidecar provider.
- Missing sidecar produces an install/runtime-needed state, not a crash.
- Missing model file produces an actionable error.
- Unknown GGUF architecture is rejected or shown as unsupported with clear UI.
- Capability metadata controls UI affordances for streaming/translate/language detection.

### Manual QA

Manual validation should include:

1. Fresh install with no GGUF sidecar installed.
2. Existing Whisper transcription.
3. Existing Parakeet transcription.
4. Installing the new sidecar.
5. Adding or downloading one supported GGUF model.
6. Running a successful transcription through the new model.
7. Running with an unsupported GGUF model and confirming safe failure.
8. Switching back to Whisper/Parakeet and confirming no regression.
9. Verifying local/cloud app modes still hydrate settings correctly.
10. Verifying overlay recording flow still works with the selected model.

### Build Validation

Required before implementation is accepted:

```bash
pnpm build
pnpm lint
```

Required when Rust sidecar code changes:

```bash
cd src-tauri && cargo check
```

Recommended before release packaging changes are accepted:

```bash
pnpm tauri build
```

## Screenshots

Implementation PR should include screenshots or screen recordings for:

1. Model catalogue showing multi-architecture models grouped or labeled by architecture.
2. Provider/model settings showing GGUF sidecar install or availability state.
3. Capability display for at least one model with known metadata.
4. Error state for unsupported/missing sidecar or unsupported model architecture.
5. Successful recording/transcription using a GGUF multi-architecture model.
6. Existing Whisper or Parakeet model still selected and functioning.

Screenshots must not contain personal data, private transcripts, tokens, local usernames, or sensitive absolute paths.

## Boundaries

### Always Do

- Keep new multi-architecture support sidecar-based.
- Preserve existing Whisper and Parakeet defaults.
- Use typed catalogue descriptors.
- Validate model paths and sidecar checksums.
- Surface errors clearly.
- Keep local models local.
- Add tests for routing, metadata fallback, and non-regression.
- Use existing styling tokens for any UI additions.

### Ask First

- Adding a new required build dependency.
- Changing CI or release signing behavior.
- Changing the default transcription provider.
- Migrating persisted settings formats in a breaking way.
- Adding cloud services or external metadata lookups.
- Bundling large model files directly into the app installer.

### Never Do

- Link GGUF/`whisper.cpp` in-process.
- Execute user-provided command strings.
- Upload local audio/model metadata for probing.
- Log raw transcripts, raw audio, secrets, or unredacted private paths.
- Remove or weaken existing Whisper/Parakeet support.
- Silently fall back to a different engine after the user selected a specific local model.

## Acceptance Criteria

1. A new sidecar-based multi-architecture engine path is designed and implemented without in-process GGUF/`whisper.cpp` linking.
2. The model catalogue can represent at least these fields per model:
   - architecture
   - engine
   - source
   - runtime requirements
   - languages
   - streaming support
   - translation support
   - language detection support
   - metadata provenance
3. The app can route GGUF multi-architecture models to the new sidecar provider.
4. Existing Whisper GGML and Parakeet ONNX models continue to work and remain default-safe.
5. Unsupported or unknown architectures fail safely with actionable user-facing errors.
6. Capability probing reads GGUF metadata where available and falls back conservatively where unavailable.
7. Sidecar binaries are versioned, checksummed, and platform-aware.
8. The release pipeline has a documented plan for bundling/downloading sidecar variants per platform and optional GPU runtime.
9. Tests cover provider routing, catalogue parsing, capability fallback, and existing-provider non-regression.
10. PR evidence includes screenshots or recordings for catalogue UI, sidecar availability, capability display, error state, and successful transcription.

## Open Questions

1. Which sidecar should be the first target: a `transcribe-cpp`-style GGUF server/CLI, expanded `sherpa-onnx`, or a Verbatim-maintained wrapper around an upstream runtime?
2. Which initial architectures should be supported in the first implementation slice?
3. Should GGUF model discovery be limited to user-provided paths initially, or should Verbatim provide downloadable curated models?
4. Should GPU variants be supported in the first release or deferred behind CPU-only support?
5. What is the minimum metadata contract required from the sidecar: architecture only, or full capability probing?
6. Should experimental models be hidden behind an advanced/experimental setting?
7. What platforms are required for first acceptance: macOS only, macOS + Windows, or all release targets?
```

