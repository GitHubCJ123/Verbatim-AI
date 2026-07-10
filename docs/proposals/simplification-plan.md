# Verbatim AI — Simplification Plan

The app (especially the AI-models layer) has accreted more engines, capture paths, preview systems, and feature flags than the core product needs. This plan identifies concrete simplifications that **do not change core functionality** — global hotkey → record → transcribe → optional LLM cleanup → paste, in both local and cloud modes.

Synthesized from a two-model complexity council (GPT-5.5 + Claude Opus 4.7), grounded in the current codebase, and cross-checked against direct recon.

**Guardrail:** every step below must be gated by the engine-matrix tests from `docs/testing/automated-testing-strategy.md`. Simplification without that safety net is how an engine silently breaks.

## The complexity surface today

**Providers × pipeline slot** (`src/lib/ai/*`):

| Slot | Cloud | Local A | Local B |
|---|---|---|---|
| Transcription | `SupabaseAIProvider` (Azure edge) | `LocalWhisperProvider` (Whisper) | `ParakeetProvider` (sherpa-onnx) |
| Cleanup (LLM) | `SupabaseAIProvider` (SSE) | `OllamaProvider` | `LlamaCppProvider` |

**"Whisper is 3 engines pretending to be 1":** `whisper-cli` (cold spawn per utterance), warm `whisper-server` (HTTP, `/load` hot-swap, idle evict), and `whisper-stream` (true streaming sidecar, opt-in, not bundled everywhere) — selectable via `sw.ai.whisperEngine` (`auto|server|cli`), plus 4 runtime variants (cpu/vulkan/cuda/metal) and a `sw.ai.whisperCompute` override.

**Three coexisting capture paths:** WebAudio (`MediaRecorder`+worklet), native cpal+rubato (now default), and streaming-sidecar-fed PCM.

**Three-deep "live preview" stack for one goal (pill text):** chunked pseudo-streaming (`sw.transcribe.livePartial`, re-transcribes a rolling window), true token streaming (`sw.transcribe.trueStreaming`), and no-preview (default). Both non-default paths are off and one isn't always shippable.

**~35–48 `sw.*` flags** in `preferences.ts` + inline in provider modules.

**Triplicated Rust sidecar plumbing:** `local_whisper.rs`, `parakeet.rs`, `llama_cpp.rs` (and the native whisper-stream) each re-implement asset selection, progress events, download streaming, checksum/signature, archive extraction, chmod, macOS quarantine strip, and executable discovery.

**Wrong core abstraction:** `AIProvider` (`src/lib/ai/AIProvider.ts`) forces every provider to implement **both** `transcribe()` and `cleanup()`. Result: Ollama/llama.cpp `throw` on `transcribe`; Whisper/Parakeet delegate to `cleanupFallback`; and `cloudCleanupFallback()` is commented "legacy … never invoked." The product is pipeline-**stage**-oriented, but the code is provider-oriented.

**Known bug surfaced during the critique:** `OllamaProvider.health()` treats a `PingResult` object as a boolean, so an unreachable Ollama can report "ready" if a model is selected (`src/lib/ai/ollama.ts` ~:420).

## What to explicitly leave alone (both models agree)

- **Cloud/local duality** — core requirement; just concentrate the gating.
- **Custom-model support** — small surface, real value.
- **Runtime compute variants** (cpu/cuda/vulkan/metal) — genuinely necessary for local perf.
- **Native capture as primary + WebAudio as internal fallback** — keep the `AudioController` abstraction; don't expose "native vs WebAudio" as a model concept.

## Ranked simplifications

### Tier A — do first (high leverage, low risk, mechanical, no product decision)

**A1. Extract a shared Rust `sidecar` / `runtime_assets` module.** Pull the duplicated download / progress / checksum-or-signature / extract / chmod / quarantine-strip / locate logic out of `local_whisper.rs`, `parakeet.rs`, `llama_cpp.rs` (and native whisper-stream) into `src-tauri/src/runtime_assets/`. Migrate Whisper first, then Parakeet, then llama.cpp. *Impact: high (removes the biggest source of native duplication + packaging risk). User impact: none if event names are preserved. Risk: medium (installer paths must be tested). Highest leverage in the plan.*

**A2. Split `AIProvider` into `Transcriber` + `Cleaner` (+ `PipelinePlan`).** Delete the fake methods (Ollama/llama `throw` on transcribe; Whisper/Parakeet `cleanupFallback`) and the legacy `cloudCleanupFallback`. Adapt existing classes to the stage interfaces. *Impact: high (kills dead scaffolding, clarifies the mental model). User impact: none. Risk: low/medium (types + refactor).*

**A3. Collapse the capture flags into one enum.** Replace `sw.audio.nativeCapture` + `sw.audio.lowLatencyMode` with a single `sw.audio.recordingEngine = standard|fast|instant` (the Settings selector already presents it this way; make the storage match). Delete the native-audio **legacy shims** (`start_native_capture`/`stop_native_capture`) and the redundant `nativeAudio.ts` fallback branch now that Fast is default and `audio.ts` owns the WebAudio fallback. *Impact: medium. User impact: none. Risk: low.*

**A4. Delete superseded command variants.** If the PCM transcribe commands fully cover the callers, remove the non-PCM `transcribe_local` / `transcribe_local_server`. *Impact: medium. Risk: low (grep the callers first).*

**A5. Fix `OllamaProvider.health()`.** Treat the ping result correctly so an unreachable daemon reports unhealthy. *Not simplification but cheap, in-scope, and prevents a confusing failure mode.*

### Tier B — high leverage, but need a product call

**B1. Hide `sw.ai.whisperEngine` from the UI.** Keep `auto` (prefer warm server; fall back to CLI internally). Server-vs-CLI is an implementation detail, not a product engine. *User impact: advanced users lose a manual toggle; core unaffected.*

**B2. Hide `sw.ai.whisperCompute`.** Auto-detect the best backend; keep an internal override only. *User impact: none for core.*

**B3. Pick one local cleanup engine.** Recommend keeping **Ollama** (no app-managed LLM runtime/model packaging) and marking **llama.cpp** experimental or removing it after migration. *Removes a whole managed-sidecar + model catalogue for a role Ollama already fills.*

**B4. Resolve the preview stack.** Ship exactly one live-preview path. Recommended: bundle `whisper-stream` everywhere and delete the chunked `livePartial` re-transcribe path (`src/lib/transcribe/{coordinator,segmenter,textMerge}.ts`); OR, if streaming can't be bundled reliably yet, delete/defer **both** preview paths (they're default-off) until one is shippable. *Removes an entire sidecar manager or an entire chunking subsystem.*

**B5. Trim the Whisper tier catalogue.** Six tiers (tiny/base/small/turbo/large-v3-q5_0/large-v3) is "model lab," not dictation UX. Curate to ~3 recommended tiers + custom-model drop-in for the rest.

**B6. Collapse the Settings → Model tab into Recommended + Advanced.** Recommended: Speech (Local / Cloud) and Cleanup (Off / Cloud / Local). Advanced: tier, compute backend, Parakeet, llama.cpp, custom models, previews. *Biggest single reduction in user-facing confusion.*

### Tier C — larger bets (listed, decide deliberately)

- **C1. Demote or drop Parakeet** — move it to "advanced/alternative engines" or a plugin; Local Whisper is the primary local speech engine.
- **C2. Unify the sidecar progress-event schema** across engines (naturally falls out of A1).
- **C3. Unify cloud vs local cleanup prompt construction** — they diverge today (`src/lib/ai/promptBuilder.ts` vs `supabase/functions/cleanup/index.ts`), so "same mode, different engine" yields different output. Share one prompt spec.
- **C4. Centralize `sw.*` in a typed settings store** with a migration layer, instead of ad-hoc `localStorage` reads inside provider modules.
- **C5. Concentrate `CLOUD_FEATURES_ENABLED` gating** in one capability resolver; move `signInAnonymouslyForCloudAi` behind it.

## Target architecture

```
Hotkey → CaptureController → Transcriber → (optional) Cleaner → paste/review
```

```ts
interface Transcriber { id: string; locality: "local"|"cloud"; health(): Promise<Health>; transcribe(i: TranscribeInput): Promise<TranscribeResult>; }
interface Cleaner     { id: string; locality: "local"|"cloud"; health(): Promise<Health>; cleanup(i: CleanupInput): AsyncIterable<string>; }
interface PipelinePlan { transcriber: Transcriber; cleaner: Cleaner | null; }
```

- **Recommended defaults:** local = Whisper (warm server, turbo); cloud = Supabase/Azure; cleanup = Off / Cloud / Ollama.
- **Internal fallbacks:** WebAudio capture; whisper-cli.
- **Advanced:** tier, compute backend, Parakeet, llama.cpp, custom Whisper, previews.

```
src-tauri/src/runtime_assets/{mod,download,archive,quarantine,progress}.rs
src-tauri/src/commands/{whisper.rs, parakeet.rs, llama_cpp.rs}  // thin, over runtime_assets
```

## Phased migration (smallest safe steps first)

0. **Inventory + safety net.** Land the engine-matrix tests (testing-strategy doc) around current provider resolution; fix `OllamaProvider.health()` (A5); reconcile stale comments (docs say native capture is default-off; code defaults on).
1. **Provider split (A2).** Introduce `Transcriber`/`Cleaner`/`PipelinePlan`; adapt classes; delete `cleanupFallback` + fake `transcribe()` + legacy cloud fallback.
2. **Shared sidecar module (A1).** Extract `runtime_assets`; migrate Whisper → Parakeet → llama.cpp.
3. **Flag + command cleanup (A3/A4).** Single `recordingEngine` enum; drop legacy native shims + non-PCM variants.
4. **Settings simplification (B6) + hide engine/compute (B1/B2).**
5. **Engine consolidation decisions (B3/B5/C1).** Ollama-only local cleanup; trimmed tiers; Parakeet demoted.
6. **Preview resolution (B4).** One preview path (or none) shipped.
7. **Cloud gating + settings store (C3/C4/C5).**

Each phase is independently shippable, behind the test guardrail, and reversible (keep the removed code one release as `@deprecated` where a rollback risk exists).

## The one-paragraph version

The core loop is simple; the AI layer around it isn't. The three biggest, safest wins are: (1) a shared Rust sidecar-runtime module to kill the triplicated download/extract/quarantine code, (2) splitting the `AIProvider` god-interface into `Transcriber`/`Cleaner` so providers stop faking the half they don't do, and (3) collapsing the flag + Settings surface (one recording-engine enum, hidden whisper engine/compute, Recommended + Advanced tabs). After that, make product calls to converge to one local-cleanup engine (Ollama), one preview path (or none), and a trimmed model catalogue — with Parakeet/llama.cpp demoted to "advanced." None of this touches the core hotkey→record→transcribe→cleanup→paste flow or the cloud/local duality.
