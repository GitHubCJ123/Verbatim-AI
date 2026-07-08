# P0 Implementation Spec — Warm, in-process Whisper engine (clean-room)

- **Tracking issue:** [#23](https://github.com/GitHubCJ123/Verbatim-AI/issues/23)
- **Builds on:** `docs/proposals/handy-adoption.md` (§4 Phase 0–2, Phase 1b)
- **Status:** Draft for review — implementation-ready for the P0 first cut
- **Branch:** `analysis/handy-comparison`

---

## 0. Clean-room mandate (read first)

We implement the **design and behavior** observed in Handy. We do **not** copy, paste, port,
translate, or line-by-line adapt Handy's source code, comments, or data files (e.g.
`catalog.json`). No Handy files are vendored into this repo.

- We reuse **ideas and architecture** (warm resident engine, preload-on-press, single-flight
  load, idle-unload). Ideas are not copyrightable; **expression is**. We reimplement the
  expression from scratch against our own types and conventions.
- Because nothing is copied, **no MIT attribution to Handy is required** and there is no
  licensing/attribution obligation to track. Handy is a *reference for behavior only*.
- Third-party crates we add (e.g. `whisper-rs`, MIT) are used under **their own** licenses via
  Cargo — that is normal dependency use, unrelated to Handy.
- **Reviewer instruction:** reject any hunk that appears derived from Handy source (same
  identifiers, structure, or comments). When in doubt, describe the behavior and re-write.

---

## 1. Scope

This spec covers only the P0 first cut, which removes the largest repeated local-mode cost:

- **P0.0** — Pipeline measurement instrumentation.
- **P0.1** — Warm, in-process Whisper engine (model resident across utterances).
- **P0.2** — Remove the `Array.from(samples)` JSON-array IPC.
- **P1b** — Preload the model on hotkey-down (small, rides on P0.1).

**Out of scope here** (later phases in `handy-adoption.md`): native `cpal` capture, VAD, the
model-catalogue overhaul, streaming, hotkey/paste changes. **Parakeet stays on its current
sidecar** for this cut; the same resident-engine pattern can wrap it in a follow-up.

**Key enabling fact:** `whisper-rs` (MIT) loads the **exact GGML `.bin` models Verbatim already
downloads** (`ggml-*.bin` under the app data dir via `commands/local_whisper.rs`). So P0.1 needs
**no re-download and no model-format change** — only a change in *how* we run inference
(in-process vs. spawning `whisper-cli`).

---

## 2. Current state (recap, cited)

- `LocalWhisperProvider.transcribe` decodes audio to 16 kHz mono f32 in JS, then invokes
  `transcribe_local` with `pcm: Array.from(samples)` — a JSON number array
  (`src/lib/ai/localWhisper.ts:197`).
- Rust `transcribe_local` writes a temp WAV and calls `run_whisper_cli`, which does
  `Command::new(cli)` + `cmd.output().await` **per call** — a fresh process and **cold model
  load every utterance** (`src-tauri/src/commands/local_whisper.rs:795,819`).
- No model is retained between calls; GPU selection is via a compute-preference setting
  (`getWhisperComputePreference`, runtime-variant detection in `local_whisper.rs`).

---

## 3. Design

### 3.1 Rust: resident engine module (new)

New module tree (our own names/structure — not Handy's):

```
src-tauri/src/transcribe/
  mod.rs        // public API: EngineManager, commands glue, TranscriptionEngine trait
  engine.rs     // TranscriptionEngine trait + WhisperEngine (whisper-rs) impl
  manager.rs    // resident state, single-flight load, idle-unload
```

- **State (Tauri managed):**
  ```
  struct EngineManager {
      inner: Arc<Mutex<EngineSlot>>,   // holds Option<Loaded>, current key, last_used
      loading: Arc<Mutex<()>>,         // single-flight guard (one load at a time)
      idle_timeout: Duration,          // default 5 min, from settings
  }
  struct Loaded { key: ModelKey, engine: Box<dyn TranscriptionEngine>, }
  ```
  `ModelKey = (tier, compute_variant)`. Managed via `app.manage(EngineManager::new(..))`.
- **`TranscriptionEngine` trait:** `load(model_path, opts) -> Self`, `transcribe(&self, pcm:
  &[f32], language: Option<&str>) -> TranscribeOutput`. One impl now: `WhisperEngine` wrapping
  `whisper_rs::WhisperContext` + `WhisperState`.
- **Load semantics (mirror Handy's safety, our code):**
  1. Fast path: if `key` matches the resident engine, reuse it (update `last_used`).
  2. Otherwise take the `loading` guard (single-flight; concurrent presses coalesce).
  3. **Drop the previous engine before allocating the new one** (avoid double peak memory).
  4. Store `Loaded`, record `last_used`.
- **Idle-unload:** a lightweight task (or check-on-use) drops the engine when
  `now - last_used > idle_timeout`. Keep it simple: check on each transcribe + a 30 s interval
  timer; setting `Immediately` unloads right after a transcription.
- **GPU:** map `WhisperComputePreference`/`WhisperRuntimeVariant` → whisper-rs context params
  (`use_gpu`, `gpu_device`) and Cargo features per platform (`metal` on macOS; `cuda`/`vulkan`
  gated on Linux/Windows, matching existing `-fa` flash-attn behavior for CUDA/Metal). Preserve
  the current auto/cuda/vulkan/cpu preference plumbing end-to-end.

### 3.2 Rust: commands

New commands in `transcribe/mod.rs`, registered in `lib.rs`:

- `ensure_engine_loaded(tier, compute_preference) -> Result<(), String>` — idempotent warm-up.
- `transcribe_pcm(tier, compute_preference, language, pcm_bytes) -> TranscribeOutput` — runs on
  the resident engine; loads if needed (single-flight).
- `unload_engine() -> Result<(), String>`.

**Migration/compat:** keep the existing `transcribe_local` command name as a **thin wrapper** that
delegates to `transcribe_pcm`, so the frontend surface barely changes and we can flip back if
needed. Keep `run_whisper_cli` behind a `sw.local.engine = "cli"` escape hatch (default
`"in-process"`) for one release to de-risk parity.

### 3.3 Frontend

- `src/lib/ai/localWhisper.ts`:
  - Replace `pcm: Array.from(samples)` with a **binary handoff** (P0.2). Preferred: send an
    `ArrayBuffer` of the f32 PCM (Tauri v2 supports `ArrayBuffer`/`Uint8Array` args efficiently);
    Rust reinterprets bytes as `&[f32]`. Fallback: write a temp WAV in Rust from bytes (we already
    do WAV for the CLI path).
  - Call `ensure_engine_loaded(tier, compute)` from `health()`/on provider selection so the model
    warms before first use.
- `src/lib/hotkey.ts` (P1b): on `hotkey:down`, fire `ensure_engine_loaded(activeTier, compute)`
  **in parallel** with mic acquisition (do not await before starting capture). Guard so a
  fast press/release doesn't leak a load.
- No change to the composite-provider contract in `src/lib/ai/index.ts`.

### 3.4 Measurement (P0.0, land first)

- TS (`localWhisper.ts`, behind `isPerfDebugEnabled()`): `performance.mark` for decode,
  serialize/IPC, and total; log payload byte size.
- Rust: log `model_load_ms` vs `inference_ms` separately (behind an env/setting flag) so we can
  prove "load ≈ 0 when warm".
- One summary line per utterance; reuse the existing perf-log style from `src/lib/audio.ts`.

---

## 4. Dependencies

- Add `whisper-rs` to `src-tauri/Cargo.toml` with per-platform features:
  `metal` (macOS), `cuda`/`vulkan` (gated, Linux/Windows) — mirroring the existing runtime-variant
  matrix. Verify the current crate version/API at implementation time (crate is MIT; loads our
  existing GGML `.bin` models).
- No new JS dependencies.

---

## 5. Acceptance criteria

1. **Warm:** 2nd+ utterances with an already-selected tier show `model_load_ms ≈ 0`
   (P0.0 log); only inference is paid.
2. **Preload:** with warm mic + P1b, a short utterance's press→result is dominated by inference,
   not setup, vs. the P0.0 baseline.
3. **IPC:** for a 30 s clip, the audio handoff is compact binary, not an N-element JSON array;
   the serialize/IPC segment shrinks by ≥ an order of magnitude.
4. **Parity:** transcript text matches the CLI path on a fixed sample set (±minor tokenization);
   language detection unchanged.
5. **Memory:** switching tiers drops the old engine first; idle-unload frees memory after the
   timeout; concurrent presses never double-load.
6. **No regressions:** cloud mode, Parakeet, warm-mic, hot-path reorder, and `fn`-key unchanged.
7. **Validation:** `corepack pnpm test`, `corepack pnpm exec tsc --noEmit`,
   `cargo check --manifest-path src-tauri/Cargo.toml` all pass; app builds.

---

## 6. Test plan

- **Rust unit:** `EngineManager` load/reuse/drop-before-alloc/single-flight (mock engine); idle
  eviction. `cargo test --manifest-path src-tauri/Cargo.toml`.
- **TS:** extend `src/lib/ai/localWhisper.test.ts` for the binary-handoff path and
  `ensure_engine_loaded` wiring (mock `invoke`).
- **Manual latency:** measure baseline (CLI) then warm engine for {tiny, turbo, large} × {5 s,
  30 s}; record the load-vs-run delta.
- **Parity:** transcribe a fixed WAV set on both paths; diff text.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `whisper.cpp` compiled into the app grows build time / binary | Feature-gate GPU backends per platform; document first-build cost; CI cache |
| whisper-rs API drift vs. this spec | Verify crate version/API at implementation; isolate behind `TranscriptionEngine` trait |
| GPU feature build failures on some targets | Default `auto`→CPU fallback; keep CLI escape hatch (`sw.local.engine="cli"`) one release |
| Parity regressions | Keep CLI path selectable; parity test gate before removing it |
| Binary f32 IPC edge cases | WAV-from-bytes fallback already proven |

---

## 8. Open decisions (maintainer sign-off)

1. **Confirm `whisper-rs`** as the engine crate (vs. deferring to a `transcribe-cpp`-style loader
   in Phase 5). *Recommendation: `whisper-rs` now — MIT, loads our existing models, mature.*
2. **Remove vs. retain the `whisper-cli` sidecar** after parity. *Recommendation: retain one
   release behind `sw.local.engine`, then remove.*
3. **When to migrate Parakeet** to the resident pattern (follow-up, not P0).

---

## 9. Rollout

Single PR (this branch) implementing P0.0 → P0.2 + P1b, with the CLI escape hatch defaulting to
in-process. Parakeet + later phases follow in separate PRs per `handy-adoption.md`.
