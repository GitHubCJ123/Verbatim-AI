<!-- verbatim-ai:artifact:v1 issue=40 phase=spec id=issue-0040-issue-0040-30e345f2-8940-48c7-b3c4-98b9692ff680-SPEC-001 display=SPEC-001 run=issue-0040-30e345f2-8940-48c7-b3c4-98b9692ff680 -->
# SPEC-001: Architect spec

- Issue: #40
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0040-issue-0040-30e345f2-8940-48c7-b3c4-98b9692ff680-SPEC-001
- Agent: architect
- Run: issue-0040-30e345f2-8940-48c7-b3c4-98b9692ff680
- Created: 2026-07-24T08:01:52.945Z

## Summary

Spec

## Body

# Spec

● skill(doc-coauthoring)

I’ll inspect the relevant catalogue/provider/runtime surfaces read-only, then draft the proposed spec content.

/ Search (glob)
  │ "docs/**/*"
  └ 72 files found

/ Search (glob)
  │ "src-tauri/src/commands/**/*"
  └ 11 files found

/ Search (glob)
  │ "src/lib/ai/**/*"
  └ 11 files found

/ Search (grep)
  │ "catalogue|catalog|model|gguf|ggml|whisper-server|whisper-cli|parakeet|sherpa|sidecar" in
  │ *.{ts,tsx,rs,json,md,toml}
  └ 8 lines found

I found an existing issue-0040 spec scaffold and the ASR runtime files; I’ll read those directly to ground the proposal in current repo facts.

● Read spec.md
  │ docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md
  └ L1:220 (37 lines read)

● Read test-plan.md
  │ docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/test-plan.md
  └ L1:220 (3 lines read)

● Read security-notes.md
  │ docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/security-notes
  │ .md
  └ L1:220 (3 lines read)

● Read AIProvider.ts
  │ src/lib/ai/AIProvider.ts
  └ L1:220 (57 lines read)

● Read index.ts
  │ src/lib/ai/index.ts
  └ L1:260 (260 lines read)

● Read parakeet.ts
  │ src/lib/ai/parakeet.ts
  └ L1:260 (201 lines read)

● Read localWhisper.ts
  │ src/lib/ai/localWhisper.ts
  └ L1:260 (249 lines read)

● Read local_whisper.rs
  │ src-tauri/src/commands/local_whisper.rs
  └ L1:260 (260 lines read)

● Read parakeet.rs
  │ src-tauri/src/commands/parakeet.rs
  └ L1:260 (260 lines read)

I’ll read the provider selection tail plus settings/model UI files so the spec can name the exact integration points.

● Read index.ts
  │ src/lib/ai/index.ts
  └ L260:420 (75 lines read)

● Read mod.rs
  │ src-tauri/src/commands/mod.rs
  └ L1:180 (10 lines read)

● Read local_whisper.rs
  │ src-tauri/src/commands/local_whisper.rs
  └ L260:620 (361 lines read)

● Read tauri.conf.json
  │ src-tauri/tauri.conf.json
  └ L1:220 (88 lines read)

● Read parakeet.rs
  │ src-tauri/src/commands/parakeet.rs
  └ L260:620 (361 lines read)

/ Search (grep)
  │ "WHISPER_TIERS|PARAKEET_VARIANTS|local-parakeet|local-whisper|AI model|transcribeProviderOverrid
  │ e|cleanupProviderOverride|listLocalModels|downloadLocalModel|downloadParakeetModel" in
  │ *.{ts,tsx} (src)
  └ 102 lines found

/ Search (grep)
  │ "whisper-runtimes|download|sha256|minisign|sidecar|externalBin|resources|bundle|beforeBuildComma
  │ nd" in *.{json,toml,rs,ts,md,yml,yaml}
  └ 8 lines found

I’ll also read the issue-specific review placeholders and settings/model slices to align the spec with the automation doc shape and UI surfaces.

● Read adversarial-review.md
  │ docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/adversarial-re
  │ view.md
  └ L1:220 (3 lines read)

● Read requirements-review.md
  │ docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/requirements-r
  │ eview.md
  └ L1:220 (41 lines read)

● Read ux-evidence.md
  │ docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/ux-evidence.md
  └ L1:220 (3 lines read)

● Read mode.ts
  │ src/types/mode.ts
  └ L1:90 (58 lines read)

● Read Settings.tsx
  │ src/routes/Settings.tsx
  └ L1160:1365 (206 lines read)

● Read ModeEditor.tsx
  │ src/routes/ModeEditor.tsx
  └ L500:555 (56 lines read)

● Read lib.rs
  │ src-tauri/src/lib.rs
  └ L1:180 (158 lines read)

● Read Settings.tsx
  │ src/routes/Settings.tsx
  └ L779:1160 (382 lines read)

Proposed `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/spec.md` content:

```markdown
# Spec: Issue #40 Full multi-architecture model catalogue

## Problem

Verbatim AI supports multiple transcription providers, but local model breadth is still limited to:

- Cloud Azure Whisper through Supabase Edge Functions.
- Local Whisper through downloaded `whisper-cli` sidecars and GGML model tiers.
- Local Parakeet through downloaded `sherpa-onnx-offline` and two Parakeet ONNX bundles.

This does not satisfy the model-breadth goal from #23: Handy-style support for many ASR architectures such as Canary, Voxtral, Qwen3-ASR, Moonshine, GigaAM, Granite, SenseVoice, and related GGUF/ONNX families.

The implementation must add an opt-in path toward a broader catalogue without regressing current defaults, startup behavior, recording latency, or the Windows build constraint that ruled out in-process whisper.cpp/GGUF linking.

## Objective

Build a data-driven, multi-architecture local ASR catalogue and runtime integration that can expose substantially more transcription models while preserving the existing provider contract and sidecar-only native runtime boundary.

Success means users can discover, download/select, and run supported non-Whisper local ASR models through a new local engine path, while Whisper and Parakeet remain unchanged and default-safe.

## Non-goals

- No in-process whisper.cpp, llama.cpp, GGUF, or transcribe-cpp linking.
- No requirement to bundle every model in the app installer.
- No change to the default transcription provider.
- No removal or rewrite of existing Whisper or Parakeet providers.
- No silent fallback from a selected local model to cloud transcription.
- No unsupported model execution based only on filename or user-provided metadata.

## Current repo facts

- Verbatim AI is a Tauri 2 desktop app with React/TypeScript frontend and Rust backend commands.
- The provider interface is `src/lib/ai/AIProvider.ts`:
  - `AIProvider.transcribe(input: TranscribeInput): Promise<TranscribeResult>`
  - `TranscribeInput` carries `audio: Blob`, optional `language`, and optional `vocabularyHints`.
  - `TranscribeResult` carries `text`, `languageDetected`, `durationMs`, and optional segments.
- Provider composition lives in `src/lib/ai/index.ts`.
  - `transcribeProvider(mode)` currently selects `cloud`, `local-whisper`, or `local-parakeet`.
  - `cleanupProvider(mode)` is independent.
  - `getActiveProvider(mode)` returns a composite transcription + cleanup provider.
- Local Whisper is implemented in:
  - `src/lib/ai/localWhisper.ts`
  - `src-tauri/src/commands/local_whisper.rs`
- Local Whisper facts:
  - Frontend has hardcoded `WHISPER_TIERS`: `tiny`, `base`, `small`, `turbo`, `large-v3`.
  - Provider kind is `AiProviderKind = "cloud" | "local-whisper" | "local-parakeet"`.
  - Rust downloads signed/verifiable runtime assets from GitHub release assets.
  - Runtime assets are selected by compute preference / platform: CPU, Vulkan, CUDA, Metal.
  - Runtime manifest is `whisper-runtimes.json` with minisign verification and SHA-256 checks.
  - Model files are downloaded from Hugging Face `ggerganov/whisper.cpp`.
  - Transcription shells out to `whisper-cli`; the app does not link whisper.cpp.
- Local Parakeet is implemented in:
  - `src/lib/ai/parakeet.ts`
  - `src-tauri/src/commands/parakeet.rs`
- Local Parakeet facts:
  - Uses `sherpa-onnx-offline` sidecar.
  - Supports variants `v2` and `v3`.
  - Runtime is CPU-only and currently available for Windows x64 and macOS Apple Silicon.
  - Model bundles are downloaded from k2-fsa/sherpa-onnx release assets.
  - Transcription writes temp WAV, invokes sidecar, parses stdout JSON/text, and removes temp audio.
- UI integration points:
  - Settings AI model tab: `src/routes/Settings.tsx`.
  - Onboarding AI model step: `src/routes/onboarding/Onboarding.tsx`.
  - Mode-level provider override UI: `src/routes/ModeEditor.tsx`.
  - Mode provider type: `src/types/mode.ts`.
  - Store mapping to Supabase/local cache: `src/lib/store/useModes.ts`.
- Tauri command registration lives in `src-tauri/src/lib.rs`.
- Current bundle resources in `src-tauri/tauri.conf.json` include `resources/whisper-runtimes/*` only.
- Existing issue #40 automation docs are present, but `spec.md`, `test-plan.md`, `security-notes.md`, `adversarial-review.md`, and `ux-evidence.md` are currently placeholders/pending.

## Architecture

### 1. Add a catalogue layer

Introduce a shared data-driven catalogue module, for example:

- `src/lib/ai/modelCatalogue.ts`
- `src/lib/ai/modelCatalogue.test.ts`

The catalogue should describe all local ASR models independently of UI rendering and runtime implementation.

Minimum model shape:

```ts
export type AsrEngineKind = "whisper-ggml" | "parakeet-onnx" | "multi-gguf";

export interface AsrModelCatalogueEntry {
  id: string;
  label: string;
  family: string;
  architecture: string;
  engine: AsrEngineKind;
  source: "bundled" | "downloadable" | "bring-your-own";
  approxSizeMB?: number;
  quantization?: string;
  languages: "auto" | string[];
  capabilities: {
    streaming: boolean;
    translate: boolean;
    languageDetection: boolean;
    timestamps: boolean;
    vocabularyHints: boolean;
  };
  runtime: {
    sidecar: "whisper-cli" | "sherpa-onnx" | "multi-gguf";
    supportedPlatforms: Array<"windows-x64" | "macos-arm64">;
    supportedCompute: Array<"cpu" | "metal" | "cuda" | "vulkan">;
  };
  download?: {
    url: string;
    sha256?: string;
    licenseLabel?: string;
    licenseUrl?: string;
  };
  notes?: string;
}
```

The initial catalogue should include existing Whisper and Parakeet entries so Settings can eventually render from the same source. Add new multi-GGUF entries only for models that have verified runtime support and licensing metadata.

### 2. Add an opt-in multi-GGUF provider

Add a new transcription provider kind:

```ts
export type TranscribeProviderKind =
  | "cloud"
  | "local-whisper"
  | "local-parakeet"
  | "local-gguf";
```

Add a provider module:

- `src/lib/ai/localGguf.ts`

Responsibilities:

- Persist selected GGUF model ID/path in localStorage.
- Expose model list/install/delete/probe helpers through Tauri invokes.
- Decode audio with existing `decodeToMonoF32_16k`.
- Call a Rust command such as `transcribe_gguf`.
- Return the existing `TranscribeResult` shape.
- Delegate cleanup exactly like Whisper and Parakeet do.

### 3. Add Rust sidecar commands

Add a Rust command module:

- `src-tauri/src/commands/local_gguf.rs`

Register commands in `src-tauri/src/lib.rs`.

Proposed Tauri commands:

- `is_gguf_runtime_installed(preference?: string) -> bool`
- `install_gguf_runtime(preference?: string) -> Result`
- `list_gguf_models() -> Vec<GgufModelInfo>`
- `download_gguf_model(model_id: String) -> Result`
- `delete_gguf_model(model_id: String) -> Result`
- `probe_gguf_model(path_or_id: String) -> GgufModelProbe`
- `transcribe_gguf(args: TranscribeGgufArgs) -> TranscribeOutput`

Runtime layout should mirror existing sidecar conventions:

```text
app_data_dir/
  gguf-asr-bin/
    cpu/
    metal/
    cuda/
    vulkan/
  gguf-asr-models/
    <model-id>/
      model.gguf
      manifest.json
  gguf-asr-tmp/
```

### 4. Sidecar selection strategy

Implementation must first evaluate and choose one of these strategies:

1. Preferred: one multi-architecture GGUF sidecar/server that can detect architecture from GGUF metadata.
2. Fallback: a `sherpa-onnx` expansion for specific architectures that cannot run through the GGUF sidecar.
3. Hybrid: route each catalogue entry to the verified sidecar that actually supports it.

The selected sidecar must:

- Be a process boundary, not a Rust/C++ linked library.
- Support JSON or otherwise stable machine-readable output.
- Support noninteractive execution suitable for Tauri commands.
- Have pinned release versions and reproducible asset names.
- Be available for at least macOS arm64 and Windows x64 before exposing a model as generally supported.

If no suitable multi-GGUF sidecar is ready, the first implementation wave should land the catalogue/probing abstractions and mark GGUF execution as unavailable with clear UI copy rather than pretending support exists.

### 5. Capability probing

Capability probing must not rely only on static catalogue entries.

For installed/BYOM GGUF files, probe:

- Architecture/model family from GGUF metadata.
- Language support if discoverable.
- Whether language detection is supported.
- Whether translation is supported.
- Whether timestamps/segments are supported.
- Whether streaming is supported by the runtime path.
- Required sample rate / audio preprocessing expectations.

Preferred probing order:

1. Use verified sidecar `inspect`/metadata JSON mode if available.
2. Otherwise parse GGUF header metadata in safe Rust without linking native GGUF libraries.
3. Reject unknown architecture or missing required metadata with a clear error.

### 6. Settings UX

Update Settings → AI model to add a fourth transcription engine:

- Cloud — Azure Whisper
- Local — Whisper
- Local — Parakeet
- Local — Model catalogue / GGUF

The GGUF/catalogue section should show:

- Runtime install state.
- Selected compute backend if applicable.
- Model cards grouped by family/architecture.
- Capability chips: languages, translate, language detect, timestamps, streaming.
- Download/install/remove controls.
- “Use this” selection.
- Explicit “experimental/opt-in” copy for the first release.
- Clear unsupported-platform messaging.

Do not make GGUF the default. Do not auto-download large models.

### 7. Onboarding UX

Onboarding should remain simple and non-regressive.

Acceptable first release behavior:

- Keep current onboarding choices focused on Cloud, Whisper, and Parakeet.
- Add a small “More local models are available later in Settings” note only if it does not complicate first-run setup.

Do not push new users into experimental multi-architecture models during onboarding.

### 8. Mode overrides

Mode-specific transcription overrides must support the new provider without breaking existing modes.

Add fields only if needed:

- If the global selected GGUF model is enough, `transcribeProviderOverride = "local-gguf"` can inherit the global selected model.
- If per-mode GGUF model selection is required, add a nullable `ggufModelOverride` field with migration/backfill in store and Supabase mapping.

Existing modes with `null`, `cloud`, `local-whisper`, or `local-parakeet` must continue loading.

### 9. Release and bundling

Extend the sidecar release pipeline using the same security posture as Whisper runtimes:

- Versioned runtime manifest.
- SHA-256 for each runtime asset.
- Minisign signature verification before extraction/use.
- Bundled resource support for offline installer/runtime asset inclusion.
- Platform/compute-specific asset naming.
- Clear 404/missing-release error messages.

Update `tauri.conf.json` resources only if runtime assets are bundled with the app.

## Security and privacy

- Local GGUF transcription must keep audio local unless the user separately selects cloud cleanup.
- Never silently fall back from local GGUF transcription to cloud transcription.
- Runtime downloads must be pinned and verified with signed manifests and checksums before extraction.
- Model downloads should use allowlisted catalogue URLs or explicit BYOM file picker paths.
- BYOM models must be treated as untrusted data:
  - Do not execute metadata from the model.
  - Do not shell-interpolate paths.
  - Pass paths as command arguments only.
  - Reject paths outside allowed user-selected/app-data locations unless explicitly selected by the user.
- Archive extraction must prevent path traversal, preserve safe permissions, and remove partial files on failure.
- Temporary WAV/PCM files must be deleted after transcription success or failure.
- Sidecar stdout/stderr logs must not include transcript text unless already expected by the parser; avoid persisting raw audio/transcript debug dumps.
- Surface licensing/source metadata for downloadable models.
- Do not add broad catch-and-ignore behavior around failed runtime/model checks.
- Preserve current privacy status behavior by updating `src/lib/privacyStatus.ts` if the new provider affects local/cloud labeling.

## Testing strategy

### Unit tests

Add or update tests for:

- Catalogue schema validation and stable IDs.
- Capability filtering/grouping.
- Provider kind parsing/defaults.
- GGUF provider localStorage defaults.
- Health status messages for missing runtime/model.
- GGUF metadata probe parsing with fixture metadata.
- Rejection of unsupported/unknown architecture metadata.
- Privacy status classification for `local-gguf`.

### Rust tests

Add focused Rust tests where feasible for:

- GGUF metadata parser with small fixture headers.
- Runtime manifest signature/checksum verification helpers.
- Archive extraction path traversal rejection.
- Model ID/path normalization.
- Sidecar argument construction does not use shell interpolation.
- Missing runtime/model error messages.

### Integration/manual tests

Manual verification matrix:

| Scenario | Expected |
|---|---|
| Existing Cloud provider selected | Transcription still uses cloud |
| Existing Local Whisper selected | Existing model download/use/delete flow still works |
| Existing Parakeet selected | Existing model download/use/delete flow still works |
| Select GGUF provider without runtime | Clear missing-runtime state; no crash |
| Install GGUF runtime | Progress shown; verified asset installed |
| Download supported GGUF model | Progress shown; model appears installed |
| Select supported GGUF model | Provider health passes |
| Transcribe with GGUF model | Text returns through existing recording pipeline |
| Delete selected GGUF model | Health fails clearly and UI prompts for download |
| Unsupported platform | GGUF section explains unavailability |
| BYOM unsupported GGUF | Probe rejects with architecture/capability error |
| Cloud cleanup + local GGUF transcription | Privacy copy indicates audio local, cleanup text cloud |
| Local cleanup + local GGUF transcription | Privacy copy indicates fully local if cleanup provider is local |

### Commands

Use existing project commands:

```bash
pnpm lint
pnpm build
pnpm tauri build
```

Use targeted test commands if/when the repo has a configured test runner for the touched TypeScript/Rust tests.

## Screenshots / UX evidence

Capture before/after screenshots for the automation evidence folder after implementation:

- `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/screenshots/before/settings-ai-model.png`
- `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/screenshots/after/settings-ai-model-gguf-empty.png`
- `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/screenshots/after/settings-ai-model-gguf-installed.png`
- `docs/automation/specs/issue-0040-full-multi-architecture-model-catalogue-gguf-eng/screenshots/after/mode-editor-provider-override.png`

Screenshots should demonstrate:

- Defaults remain unchanged.
- GGUF/catalogue provider is opt-in.
- Missing runtime/model states are understandable.
- Installed model cards show architecture and capabilities.
- Mode override UI includes the new provider if implemented.

## Implementation waves

### Wave 1: Catalogue foundation

- Add shared model catalogue types and static entries for existing Whisper/Parakeet.
- Add tests for catalogue shape, grouping, and capability metadata.
- Do not change runtime behavior yet.

### Wave 2: Sidecar feasibility and runtime manifest

- Select/pin the multi-GGUF sidecar strategy.
- Add runtime asset manifest shape and verification path.
- Add Rust install/is-installed commands.
- Keep UI hidden or disabled if runtime is not available for the platform.

### Wave 3: GGUF model management and probing

- Add model install/list/delete commands.
- Add GGUF metadata/capability probe.
- Add BYOM probe path if included in scope.
- Reject unknown/unsupported architectures.

### Wave 4: Provider integration

- Add `local-gguf` provider kind and `LocalGgufProvider`.
- Wire into `getActiveProvider`.
- Add health checks and transcription command.
- Preserve existing provider behavior.

### Wave 5: Settings and mode UI

- Add catalogue/GGUF section to Settings.
- Add mode override support.
- Update onboarding only with lightweight pointer copy if desired.
- Update privacy status copy.

### Wave 6: Release pipeline and evidence

- Add bundled resource mapping if runtime assets are bundled.
- Document release asset names and manifest signing.
- Capture screenshots.
- Fill `test-plan.md`, `security-notes.md`, `ux-evidence.md`, and adversarial review.

## Acceptance criteria

- Existing Cloud, Whisper, and Parakeet flows continue to work unchanged.
- A new opt-in local model catalogue/GGUF provider is available only where runtime support is verified.
- No in-process native GGUF/whisper.cpp/transcribe-cpp linking is introduced.
- Runtime and model downloads are verified or explicitly BYOM.
- Installed GGUF models expose architecture and capabilities in UI.
- Unsupported models fail with actionable errors before transcription.
- Provider health reports missing runtime/model/capability states clearly.
- Mode overrides and global provider selection remain backward-compatible.
- Local/cloud privacy status remains accurate for every transcription + cleanup combination.
- Release pipeline has a documented path for platform/GPU-specific sidecar assets.
- Screenshots and test evidence are added under the issue automation folder.

## Open questions

- Which multi-architecture sidecar should be standardized for the first release?
- Which exact model families should be enabled in the first catalogue wave?
- Should BYOM GGUF be included in the first implementation or delayed until after downloadable catalogue models work?
- Is per-mode GGUF model selection required, or is global selected model sufficient for the first release?
- What minimum platform matrix is required before exposing the provider outside experimental copy?
```

