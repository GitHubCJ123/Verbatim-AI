# Spec & Proposal — Adopting Handy's fast local pipeline, VAD, and extensible model catalogue

- **Tracking issue:** [#23](https://github.com/GitHubCJ123/Verbatim-AI/issues/23)
- **Status:** Draft for review (no code changes yet)
- **Branch/worktree:** `analysis/handy-comparison`
- **Reference app:** [cjpais/Handy](https://github.com/cjpais/Handy) (MIT, © 2025 CJ Pais)

This spec turns the comparison in #23 into an actionable, phased implementation plan with
file-level changes, sequencing, acceptance criteria, and a measurement plan. It is intentionally
**downstream** of the work already shipped in `docs/improvement-plan/` (warm-mic, hot-path
reorder, macOS `fn` key, quick-start, settings palette, transcript-log privacy).

---

## 1. Goals & non-goals

### Goals
1. Remove the biggest repeated local-mode cost: **cold model load + process spawn on every
   utterance**.
2. Make local transcription **fast and warm**: model resident in memory, preloaded on hotkey-down.
3. Add **VAD** for silence trimming, fewer hallucinations, and (eventually) auto-stop.
4. Make the **model catalogue extensible**: bring-your-own-GGUF, quantized large variants, and
   honest per-model capabilities — without a hard cutover of today's models.
5. Do all of the above **measured**, not by intuition.

### Non-goals
- No change to the **cloud tier** (Azure via Supabase Edge Functions) or the subscription plans
  tracked in #21/#22. This work is orthogonal and improves only the local path.
- No re-doing of already-shipped improvement-plan items.
- Not committing to shipping *every* phase; P0 is the must; P1–P2 are incremental and independently
  shippable.

---

## 2. Current-state autopsy (Verbatim)

| Concern | Where | Cost / issue |
|---|---|---|
| Audio captured in webview | `src/lib/audio.ts` | `MediaRecorder` returns only the **final Blob on stop** → no real-time frames (blocks VAD auto-stop & streaming) |
| Audio → Rust handoff | `src/lib/ai/localWhisper.ts:197`, `parakeet.ts:158` | `pcm: Array.from(samples)` sends the entire clip as a **JSON number array** over IPC |
| Whisper transcription | `src-tauri/src/commands/local_whisper.rs:795` (`run_whisper_cli`) | `Command::new(cli)` + `cmd.output().await` **per utterance**; writes temp WAV (`:943`) |
| Parakeet transcription | `src-tauri/src/commands/parakeet.rs:554` | Same per-utterance CLI spawn (`:579`), temp WAV (`:542`) |
| Model reuse | — | **None.** Each call cold-loads the model from disk and exits |
| VAD | — | **None** anywhere in `src/` or `src-tauri/src/` |
| Model catalogue | `ai/localWhisper.ts` (`WHISPER_TIERS`), `ai/parakeet.ts` (`PARAKEET_VARIANTS`) | 5 Whisper tiers + 2 Parakeet variants, **hardcoded enums + fixed URLs**, no custom-model path |

Net: every dictation pays (a) webview capture + webm encode, (b) decode to PCM in JS, (c) a large
JSON-array IPC, (d) a temp WAV write, (e) a **process spawn**, and (f) a **cold model load**.
(a)–(d) scale with clip length; (e)–(f) are fixed per-utterance taxes.

---

## 3. Handy reference architecture (what we're adopting)

| Mechanism | Handy source | What to take |
|---|---|---|
| Resident engine | `managers/transcription.rs:221` (`engine: Arc<Mutex<Option<LoadedEngine>>>`), stored `:656` | Hold the loaded model in Tauri managed state |
| Load safety | `transcription.rs:494` (drop old before alloc new), `:689` (single-flight guard), `:274` idle watcher; `settings.rs:133` unload timeout (default 5 min) | Avoid double peak memory; dedupe concurrent loads; auto-unload when idle |
| Preload on press | `actions.rs:451` | Kick model (+VAD) load in parallel the moment the hotkey fires |
| Native capture | `audio_toolkit/audio/recorder.rs` (cpal worker), `resampler.rs` (rubato→16 kHz, 30 ms frames) | Real-time mono f32 frames without a webview round-trip |
| VAD | `audio_toolkit/vad/silero.rs`, `vad/smoothed.rs`, `vad/mod.rs` | Silero + smoothing (prefill 450 ms, onset 60 ms, hangover 450/1650 ms) |
| Catalogue | `catalog/mod.rs:79` (`catalog.json`→`transcribe-cpp`), `managers/model.rs:1416` (custom discovery), `model_capabilities.rs` (GGUF header probe) | Data-driven catalogue + BYO-GGUF + capability metadata |
| Streaming | `transcription.rs:750` (`StreamRouter`), `transcription_coordinator.rs` (coordinator + 30 ms debounce) | Live partial transcript without per-frame IPC thrash |
| Hotkey | `shortcut/handy_keys.rs:411` (permissive), dynamic cancel (Esc) during recording | Modifier-only/key-only triggers; cancel shortcut |
| Paste | `settings.rs:149` (6 methods) | Shift+Insert (terminals), Linux direct-type default |

---

## 4. Phased design

> **Hard sequencing constraint.** VAD **auto-stop** and **live streaming** require a real-time
> frame path. Verbatim's `MediaRecorder` only emits the final Blob on stop, so those features are
> gated on Phase 3 (native `cpal` **or** a WebAudio AudioWorklet). *Post-hoc* silence trimming does
> **not** need Phase 3 and can ship earlier.

### Phase 0 — Measurement instrumentation (P0, prerequisite)

**Why:** Prioritization and acceptance criteria need real numbers; the app already has a
perf-debug flag (`isPerfDebugEnabled()` in `src/lib/preferences.ts`, used in `audio.ts`).

**Changes:**
- Frontend: in `src/lib/ai/localWhisper.ts` / `parakeet.ts`, wrap the pipeline with
  `performance.mark`/`measure` capturing: decode ms, `Array.from` + IPC send ms, IPC payload bytes,
  and total round-trip. Emit one summary line behind `sw.debug.perf`.
- Rust: in `run_whisper_cli` (`local_whisper.rs`) and the Parakeet runner, log **model-load vs
  run** split (spawn start → first output vs. total) and WAV-write ms behind an env/setting flag.
- Add a tiny `docs/improvement-plan/` note or reuse the existing perf log format.

**Acceptance:** a single toggle produces a per-utterance breakdown (decode / serialize / IPC /
WAV / spawn+load / run / cleanup / paste) on a real machine, for tiny/turbo/large models and
short/long clips. This baseline is referenced by every later phase.

### Phase 1 — Persistent / in-process transcription engine (P0, the big win)

**Design:** introduce a resident engine held in Tauri managed state, mirroring Handy.

```
src-tauri/src/transcribe/
  mod.rs            // TranscriptionEngine trait + LoadedEngine enum + manager
  manager.rs        // Arc<Mutex<Option<LoadedEngine>>> + load/unload/single-flight/idle-timeout
  whisper.rs        // whisper backend impl
  parakeet.rs       // parakeet backend impl (wraps existing sherpa path)
```

- `EngineManager` owns `engine: Arc<Mutex<Option<LoadedEngine>>>`, `current_model_id`, an
  idle-unload timeout (default 5 min, configurable), and a **single-flight** load guard
  (`Mutex`/`Notify`) so concurrent presses don't double-load.
- On load: **drop the previous engine before allocating** the new one (avoid double peak memory).
- New Tauri commands (replace the per-call CLI path): `ensure_engine_loaded(model_id)`,
  `transcribe_pcm(model_id, pcm|wav_path, language) -> {text, language, duration_ms}`,
  `unload_engine()`. Keep the existing command names as thin wrappers for a smooth migration.
- Frontend: `LocalWhisperProvider`/`ParakeetProvider` call `ensure_engine_loaded` on selection and
  `transcribe_pcm` on stop; no behavioral change to the composite-provider API in `ai/index.ts`.

**Engine crate decision (needs maintainer sign-off — see §7):**
- **Option A — `whisper-rs` (+ keep sherpa-onnx for Parakeet).** Mature, widely used, in-process
  Whisper with Metal/CUDA/Vulkan features. Fastest path to the warm-engine win. Does **not** unlock
  Handy's multi-architecture catalogue.
- **Option B — `transcribe-cpp`-style GGUF loader (Handy's crate).** One loader for many
  architectures (arch from GGUF header) → unlocks Phase 5 catalogue directly. Newer/less-proven
  dependency; larger build surface.
- **Recommendation:** **A now, B later.** Ship the warm-engine win with `whisper-rs` (low risk),
  and adopt a `transcribe-cpp`-style loader in Phase 5 when catalogue breadth is the goal. Design
  the `TranscriptionEngine` trait so swapping the Whisper backend is contained.
- **Fallback (if in-process is rejected):** convert each sidecar into a **long-lived server
  process** (spawn once, feed audio over stdin/socket, keep model warm). Gets ~80% of the latency
  win without linking native ASR into the binary.

**Keep GPU support:** preserve the existing compute-preference plumbing
(`getWhisperComputePreference`, runtime variant detection in `local_whisper.rs`); map it to the
in-process backend's accelerator selection at load time.

**Acceptance:**
- Second and subsequent utterances with an already-selected model show **no model-load cost**
  (Phase 0 breakdown: load ≈ 0 after warm).
- First utterance after selection preloads (see Phase 1b) so the model is usually ready by stop.
- Parity: transcript text/quality unchanged vs. the CLI path on a fixed sample set.
- Idle-unload frees memory after the timeout; concurrent presses never double-load.

### Phase 1b — Preload on hotkey-down (P0, small, rides on Phase 1)

- In the hotkey path (`src/lib/hotkey.ts` → recording bridge, or a new Rust hook), call
  `ensure_engine_loaded(activeModelId)` **in parallel** with mic acquisition on `hotkey:down`.
- Split from VAD preload: **model** preload lands with Phase 1; **VAD** preload only once VAD exists
  (Phase 4).

**Acceptance:** with warm mic + preloaded model, press→result on a short clip is dominated by
inference, not setup (quantified against Phase 0 baseline).

### Phase 2 — Remove the JSON-array IPC (P0, independent)

- Replace `pcm: Array.from(samples)` with a binary handoff: either (a) write PCM/WAV to a temp file
  and pass the path (Rust already writes a temp WAV, so this removes a redundant serialize), or
  (b) send an `ArrayBuffer`/`Uint8Array` via Tauri's byte-friendly channel.
- Files: `src/lib/ai/localWhisper.ts`, `parakeet.ts`, and the corresponding Rust command signatures.

**Acceptance:** IPC payload for a 30 s clip drops from an N-element JSON array to a compact binary;
Phase 0 shows the serialize+IPC segment shrink materially. Subsumed later by Phase 3.

### Phase 3 — Real-time frame capture (P1, gates VAD auto-stop & streaming)

Two viable routes; pick per §7:
- **3A — WebAudio AudioWorklet (lighter).** Add an `AudioWorkletNode` alongside the existing
  `AnalyserNode` in `audio.ts` to emit 16 kHz mono f32 frames (e.g. 30 ms) during recording, posted
  to the pipeline. Reuses current capture/permissions; no new native code.
- **3B — Native `cpal` capture (Handy-parity).** Move capture to Rust (`cpal` + `rubato`), emit
  frames on a worker thread. Bigger refactor; removes the webview from the hot path entirely and
  enables the cleanest streaming path.

**Recommendation:** **3A first** (unblocks Phase 4/6 with minimal risk), keep **3B** as the
longer-term native path once the engine and VAD are proven.

**Acceptance:** the pipeline receives PCM frames *during* recording (not just on stop), verified by
a frame counter behind the perf flag.

### Phase 4 — Silero VAD (P1)

- Add a VAD module (Rust, via a Silero ONNX crate such as `vad-rs`, or ONNX Runtime directly),
  mirroring Handy's `SmoothedVad` (prefill 450 ms, onset 60 ms, hangover 450/1650 ms).
- **4a Post-hoc trim (no Phase 3 needed):** run VAD over the finished PCM before transcription to
  trim leading/trailing silence and drop pure-noise clips (prevents Whisper silence-hallucination).
- **4b Auto-stop (needs Phase 3):** feed live frames to VAD; stop on hangover expiry for hands-free
  endpointing (a setting, default off to preserve PTT/toggle behavior).

**Acceptance:** 4a measurably reduces audio duration handed to the engine on clips with
leading/trailing silence, with no transcript regressions; 4b auto-stops within the configured
hangover on a manual test.

### Phase 5 — Model-catalogue overhaul (P1)

- Introduce a **catalogue abstraction** (a data file + loader) replacing the hardcoded
  `WHISPER_TIERS`/`PARAKEET_VARIANTS` enums, modeled on Handy's `catalog.json` → descriptor flow.
- **Custom-model discovery:** scan the app models dir for `.gguf`/`.bin`, register as custom models,
  expose a `rescan_local_models` command (Handy `managers/model.rs:1416`, `commands/models.rs`).
- **Quantized large variants:** add e.g. `large-v3 q5_0 ≈ 1.1 GB` so "Max" quality is usable
  without the 3.1 GB full weights.
- **Capability probing:** if/when on GGUF (Option B), read GGUF KV metadata for
  languages/streaming/translate/lang-detect and surface honestly in Settings → Models.
- Best paired with Option B (`transcribe-cpp`-style loader) so one mechanism covers every arch;
  under Option A this phase still delivers custom-Whisper-GGML discovery + quantized variants.

**Acceptance:** dropping a `.gguf`/`.bin` into the models dir makes it selectable after a rescan;
a quantized large variant is offered; existing tiers keep working (no hard cutover).

### Phase 6 — Streaming transcription + coordinator (P2, depends on Phase 3)

- Add a **StreamRouter-style** feed so streaming-capable engines update a live transcript without
  per-frame Tauri IPC; serialize lifecycle with a **coordinator + 30 ms debounce** (Handy
  `transcription_coordinator.rs`).
- Surface partial text in the overlay; finalize on stop.

**Acceptance:** for a streaming-capable engine, partial text appears while speaking; no IPC-storm
(frame updates coalesced), and rapid press/release is debounced.

### Phase 7 — Hotkey, paste, inline post-processing (P2, small independent wins)

- **Hotkey:** add **modifier-only** triggers (e.g. Right ⌘) and a **cancel-during-recording (Esc)**
  shortcut registered only while recording; add a 30 ms debounce. Extend the existing
  `set_hotkey` sentinel approach (`commands/hotkey.rs`, `fn_hotkey.rs`).
- **Paste:** add **Shift+Insert** (terminals) and make **direct-type** the Linux default
  (`commands/paste.rs`).
- **Inline post-processing:** LLM-independent filler-word filter + fuzzy custom-word correction
  before/instead of the cleanup step.

**Acceptance:** each is independently togglable and covered by a focused manual test.

---

## 5. Sequencing / dependency graph

```
P0.0 Measure ──▶ P0.1 Persistent engine ──▶ P1b Preload model
                        │
                        └────────────▶ P5 Catalogue (Option B loader)
P0.2 Remove JSON IPC  (independent, do alongside P0.1)
P1.3 Real-time frames ──▶ P4b VAD auto-stop
        │              └▶ P6 Streaming + coordinator
P4a Post-hoc VAD trim  (independent of P1.3)
P7 Hotkey / paste / inline post-proc  (independent, anytime)
```

**Recommended first cut to ship:** P0.0 + P0.1 + P0.2 + P1b. That removes the per-utterance
model-load + process-spawn + JSON-IPC taxes — the largest, most obvious repeated costs — and is
independently valuable before any capture/VAD/streaming refactor.

---

## 6. Acceptance criteria (overall) & measurement plan

- **Baseline (P0.0):** per-utterance breakdown captured on a real machine for {tiny, turbo,
  large} × {5 s, 30 s} clips, before any change.
- **Warm-engine win (P1):** after warm-up, the "model load" segment ≈ 0 on subsequent utterances;
  report the delta vs. baseline. No transcript-quality regression on a fixed sample set.
- **IPC (P2):** serialize+IPC segment for a 30 s clip reduced by ≥ an order of magnitude.
- **VAD (P4a):** audio duration sent to the engine reduced on silence-padded clips; hallucination
  spot-check improved. **(P4b):** auto-stop fires within the configured hangover.
- **Catalogue (P5):** BYO-GGUF discoverable after rescan; quantized large variant selectable.
- **No regressions:** cloud mode, warm-mic, hot-path reorder, and `fn`-key behavior unchanged.
- **Validation commands** (existing): `corepack pnpm test`, `corepack pnpm exec tsc --noEmit`,
  `cargo check --manifest-path src-tauri/Cargo.toml`.

---

## 7. Open decisions (need maintainer sign-off)

1. **Engine crate:** `whisper-rs` now vs. `transcribe-cpp`-style loader now vs. in-process rejected
   (sidecar-server fallback). *Recommendation: `whisper-rs` first, transcribe-cpp-style in P5.*
2. **Capture route:** AudioWorklet (3A) vs. native `cpal` (3B) for the first real-time-frame
   increment. *Recommendation: 3A first.*
3. **Scope of first PR:** the "first cut" in §5 only, or bundle VAD post-hoc trim (P4a)?
4. **Binary-size budget & target platforms** for GPU features (Metal/CUDA/Vulkan) in an in-process
   build.
5. **LICENSE:** this repo has none; adding one clarifies whether MIT Handy code can be reused
   directly vs. reimplemented.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| In-process native ASR grows binary / build time | Feature-gate GPU backends per-platform (as Handy does); keep sidecar-server fallback |
| `transcribe-cpp` dependency maturity | Start with `whisper-rs`; isolate behind the `TranscriptionEngine` trait |
| Native `cpal` refactor risk | Prefer AudioWorklet (3A) first; 3B later |
| VAD auto-stop surprises PTT users | Ship post-hoc trim first; auto-stop is opt-in, default off |
| Perceived-speed claims are multi-factor | P0.0 measurement gates every claim |
| MIT attribution / licensing | Reimplement designs; add a LICENSE; attribute any reused code |

---

## 9. Appendix

- **Handy crates of interest:** `transcribe-cpp` (GGUF, multi-arch), `transcribe-rs` (legacy ONNX),
  `vad-rs` (Silero), `cpal` (capture), `rubato` (resample), `hf-hub` (downloads/cache).
- **Verbatim files most affected:** `src-tauri/src/commands/local_whisper.rs`,
  `src-tauri/src/commands/parakeet.rs`, new `src-tauri/src/transcribe/*`, `src/lib/audio.ts`,
  `src/lib/ai/localWhisper.ts`, `src/lib/ai/parakeet.ts`, `src/lib/ai/index.ts`,
  `src/lib/hotkey.ts`, `src-tauri/src/commands/paste.rs`, plus Settings → Models UI.
- **Do-not-redo:** warm-mic, hot-path reorder, `fn` key, quick-start, settings palette,
  transcript-log privacy (`docs/improvement-plan/`).
