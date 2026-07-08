# P0 Implementation Spec — Warm Whisper via a persistent `whisper-server` sidecar (clean-room)

- **Tracking issue:** [#23](https://github.com/GitHubCJ123/Verbatim-AI/issues/23)
- **Builds on:** `docs/proposals/handy-adoption.md` (§4 Phase 0–2, Phase 1b)
- **Status:** Draft for review — revised after a GPT-5.5 design critique
- **Branch:** `analysis/handy-comparison`

> **Revision note.** An earlier draft proposed linking Whisper in-process via `whisper-rs`. A
> design critique surfaced a **blocking** conflict: this codebase *deliberately* avoids linking
> whisper.cpp because it "hit bindgen/libclang version-mismatch issues on Windows"
> (`src-tauri/src/commands/local_whisper.rs:1-6`), and today's GPU support is **runtime-downloaded
> sidecar variants** (`local_whisper.rs:278-297`), not build-time features. This spec therefore
> uses a **persistent `whisper-server` process** instead: it keeps the model warm **without any
> in-process linking**, reuses the **exact same models and GPU-variant infrastructure**, and
> avoids reintroducing the Windows build problems.

---

## 0. Clean-room mandate (read first)

We implement the **design/behavior** from Handy (warm resident model, preload-on-press,
single-flight readiness, idle-unload). We do **not** copy, port, or adapt Handy's source code,
comments, or data. Ideas are reused; **expression is reimplemented** against our own types.
Because nothing is copied, **no attribution/licensing obligation to Handy applies**; Handy is a
reference for behavior only. `whisper.cpp`/`whisper-server` (MIT) is used as an **external
prebuilt binary** (as the app already does for `whisper-cli`) — normal dependency use, unrelated
to Handy. **Reviewers:** reject any hunk that appears derived from Handy source.

---

## 1. Scope & approach

Deliver the P0 first cut: remove the **cold model load + process spawn on every utterance**.

- **P0.0** — Pipeline measurement (baseline vs. warm).
- **P0.1** — Run transcription against a **persistent `whisper-server`** kept warm across
  utterances (model resident in the server process), replacing the per-utterance `whisper-cli`
  spawn.
- **P0.2** — Reduce the `Array.from(samples)` JSON-array IPC between the webview and Rust.
- **P1b** — Ensure the server is warm (spawned/model-loaded) on hotkey-down.

**Out of scope** (later phases in `handy-adoption.md`): native `cpal` capture, VAD, catalogue
overhaul, streaming, hotkey/paste. **Parakeet stays on its current sidecar** for this cut.

**Why the server approach fits:** it keeps the model in memory (the #1 win) while reusing (a) the
existing GGML `.bin` models under `whisper-models/` (`local_whisper.rs:93-100,123-126`), and
(b) the existing signed runtime-archive + GPU-variant selection (`local_whisper.rs:278-297`,
`default_runtime_variant()` :210-233). No in-process linking, no GPU-parity loss.

---

## 2. Current state (recap, cited)

- Models: `app_data_dir/whisper-models/ggml-{tiny,base,small,large-v3-turbo-q5_0,large-v3}.bin`
  (`local_whisper.rs:93-100,123-126`); downloaded from HuggingFace `ggerganov/whisper.cpp`
  (`:102-106`).
- Runtime binary: `app_data_dir/whisper-bin/whisper-cli(.exe)` (+ DLLs), obtained from Verbatim's
  **own** signed GitHub release archives `whisper-bin-<platform>-<variant>.zip` via a signed
  manifest (`local_whisper.rs:263-297,442-512`). GPU variant chosen at runtime by
  `default_runtime_variant()` (Windows: nvcuda/vulkan DLL probe; macOS arm64: Metal; else CPU)
  (`:210-233`).
- Transcription: `transcribe_local` → temp WAV → `run_whisper_cli` = `Command::new(cli)` +
  `cmd.output().await` **per utterance** (cold model load each time) (`:785-819,939-953`).
- Audio → Rust: `pcm: Array.from(samples)` JSON array (`src/lib/ai/localWhisper.ts:196-210`).

---

## 3. Design

### 3.1 `whisper-server` acquisition (release-pipeline change)

- Bundle the `whisper-server` binary **inside the existing `whisper-bin-<platform>-<variant>.zip`
  archives** (built in `.github/workflows/release.yml` alongside `whisper-cli`). Because it lives
  in the same archive, the **signed manifest asset list is unchanged** — only the archive contents
  grow. The app then finds `whisper-bin/whisper-server(.exe)` next to `whisper-cli`.
- Add `whisper-server` to the executable-permission fix-up already done for `whisper-cli`
  (`local_whisper.rs:579`).
- **Required pre-implementation spike:** confirm `whisper-server` builds and runs for every
  variant we ship (Windows CPU/CUDA/Vulkan, macOS arm64 Metal). For local dev/test, a locally
  built `whisper-server` placed in `whisper-bin/` is sufficient; the workflow change lands with
  this PR but only affects users after the next signed release.

### 3.2 Rust: `whisper-server` process manager (new module)

New module `src-tauri/src/commands/whisper_server.rs` (our own code):

```
struct ServerHandle { child: Child, port: u16, model_key: ModelKey, base_url: String, last_used: Instant }
struct WhisperServerState { inner: Arc<Mutex<Option<ServerHandle>>>, starting: Arc<tokio::sync::Mutex<()>>, idle: Duration }
```

- **Send/Sync-safe by construction:** we hold a `Child` + `u16` + `String` — **no whisper types
  in-process** (this sidesteps the whisper-rs `WhisperState: !Sync`/`&mut` problems entirely).
- **`ensure_server(tier, compute)`**:
  1. Fast path: if a live server matches `(tier, variant)` → update `last_used`, return `base_url`.
  2. Take the `starting` guard (single-flight; concurrent presses coalesce).
  3. If a server for a **different** model is running, **kill it first** (drop before spawn) —
     whisper-server serves one model per process.
  4. Pick a free loopback port (bind `TcpListener` on `127.0.0.1:0`, read the port, drop it), then
     spawn `whisper-server -m <model.bin> --host 127.0.0.1 --port <port> [-fa for CUDA/Metal]`
     with `CREATE_NO_WINDOW` on Windows (mirror `local_whisper.rs`).
  5. **Health-poll** `GET /` (or `/health`) on the port until ready or timeout; store the handle.
- **Idle-unload:** a 30 s interval task kills the server when `now - last_used > idle` (default
  5 min, configurable). Kill on model switch and on app exit (`RunEvent::Exit`).
- **Crash recovery:** if a request fails with a connection error, mark the handle dead and
  re-`ensure_server` once.
- **GPU:** reuse `default_runtime_variant()` / the compute preference exactly as the CLI path does;
  pass `-fa` for CUDA/Metal like `run_whisper_cli` (`local_whisper.rs:799-801`). No new GPU logic.

### 3.3 Rust: commands & request mapping

- Commands (in `whisper_server.rs`, registered in `lib.rs`): `ensure_engine_ready(tier,
  compute_preference)`, `unload_engine()`.
- `transcribe_local` **keeps its name/signature** but branches on an **engine mode** arg
  (`"server" | "cli"`, default `"server"`): server path calls `ensure_server` then **POSTs the WAV
  to `http://127.0.0.1:<port>/inference`** (multipart `file=@wav`) with fields mapped from the
  existing CLI flags:
  - `-nt` → `no_timestamps=true`; `-l <lang>` → `language`; `-tr` → `translate` (**preserve the
    `translate` arg** from `TranscribeArgs`, `local_whisper.rs:722-729`); `response_format=json`.
  - Parse the JSON response `text` and detected `language`; keep the existing
    `{text, language_detected, duration_ms}` return shape.
  - Reuse the existing WAV writer (`local_whisper.rs:939-953`) so audio format is identical to the
    CLI path (guarantees parity).
- HTTP client: reuse the crate already used for runtime downloads (`reqwest`, see
  `local_whisper.rs:389,464`). No new dependency.
- Keep `run_whisper_cli` intact as the `"cli"` fallback.

### 3.4 Frontend

- `src/lib/ai/localWhisper.ts`:
  - Add `getLocalWhisperEngineMode(): "server" | "cli"` (localStorage, default `"server"`) and pass
    `engine` in `TranscribeArgs` (Rust cannot read localStorage — critic fix).
  - **P0.2:** stop sending `pcm: Array.from(samples)`. Preferred: send the PCM as bytes via a
    top-level raw invoke (`tauri::ipc::Request`), or write the WAV in Rust from a `Uint8Array`
    (we already build a WAV). Decode f32 via `f32::from_le_bytes` chunks (require `len % 4 == 0`);
    no unsafe reinterpret (critic fix).
  - Call `ensure_engine_ready(resolvedTier, compute)` from `health()` / on provider selection.
- `src/lib/hotkey.ts` (**P1b**): on `hotkey:down`, if the resolved provider is local-whisper, fire
  `ensure_engine_ready(tier, compute)` **in parallel** with mic acquisition. **Use the resolved
  mode's `whisperTierOverride`** (via the same resolution as `ai/index.ts:279`), not a blind
  `getLocalWhisperTier()` (critic fix). Fast press/release does **not** cancel a spawn — let it
  finish; the idle timer reclaims it (critic fix: loads aren't cheaply cancelable).
- No change to the composite-provider contract in `ai/index.ts`.

### 3.5 Registration (explicit — critic fix)

- Add `pub mod whisper_server;` under `commands/mod.rs`; import commands + `WhisperServerState`
  into `lib.rs`; `.manage(WhisperServerState::new(..))` next to existing managed state
  (`lib.rs:64-67`); add the new commands to `generate_handler!` (`lib.rs:84-115`); ensure
  `transcribe_local` is not double-registered. Kill the server on `RunEvent::Exit`.

### 3.6 Measurement (P0.0, land first)

- TS (behind `isPerfDebugEnabled()`): mark decode, serialize/IPC bytes, HTTP round-trip, total.
- Server model makes the split natural: **first** request after (re)spawn = cold (model load in the
  server); **subsequent** = warm. Log server-spawn ms separately from request ms. (The old CLI's
  `cmd.output().await` can only give a single total — measure it as the baseline.)

---

## 4. Dependencies

- **No new Rust linking deps.** Reuse `reqwest` (already present) for the loopback POST.
- Release workflow bundles a `whisper-server` binary into the runtime archives (build-time only).
- No new JS deps.

---

## 5. Acceptance criteria

1. **Warm:** 2nd+ utterances against a running server show **no model-load cost**; only inference +
   a loopback round-trip are paid (P0.0 log).
2. **Preload:** with warm mic + P1b, the server is ready by the time the user stops; short-clip
   press→result is dominated by inference vs. the CLI baseline.
3. **IPC:** the webview→Rust audio handoff is compact (bytes/WAV), not an N-element JSON array.
4. **Parity:** transcript text + detected language match the CLI path on a fixed sample set (same
   WAV, same model, same flags).
5. **Lifecycle:** switching tiers kills+respawns; idle-unload kills after timeout; app exit kills
   the server (no zombies); a dead server is transparently respawned once.
6. **GPU:** the server uses the same runtime variant as the CLI would (CUDA/Vulkan/Metal/CPU).
7. **Fallback:** `engine="cli"` still works unchanged.
8. **No regressions:** cloud mode, Parakeet, warm-mic, hot-path reorder, `fn`-key unchanged.
9. **Validation:** `corepack pnpm test`, `corepack pnpm exec tsc --noEmit`,
   `cargo check --manifest-path src-tauri/Cargo.toml` pass; app builds.

---

## 6. Test plan

- **Rust unit:** `WhisperServerState` port selection; single-flight (concurrent `ensure_server`
  spawns one); kill-before-respawn on model switch; idle eviction; dead-handle respawn. Use a
  **fake server binary** (a tiny script that binds the port and answers `/inference`) so tests
  don't need real weights. `cargo test --manifest-path src-tauri/Cargo.toml`.
- **TS:** extend `src/lib/ai/localWhisper.test.ts` for engine-mode selection + binary handoff
  (mock `invoke`); assert `translate`/language are forwarded.
- **Manual latency + parity:** baseline (CLI) vs warm server for {tiny,turbo,large} × {5 s,30 s};
  diff transcripts on a fixed WAV set.
- **Build matrix (acceptance gate):** Windows CPU, Windows CUDA/Vulkan (or CLI fallback), macOS
  arm64 Metal, no-GPU CPU.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `whisper-server` not built for a variant | Pre-impl spike; if missing, fall back to CLI for that variant via `engine="cli"` |
| Release-archive/manifest change needed | Bundle server in the *same* zip → asset list/manifest unchanged; only contents grow |
| Loopback port conflict / firewall prompt | Bind `127.0.0.1:0` (ephemeral, no external listen); localhost only |
| Orphaned server process | Kill on model switch, idle timeout, and `RunEvent::Exit`; track the `Child` |
| First-request latency still includes model load | Expected; P1b preload + warm keep-alive amortize it; measured in P0.0 |
| Parity drift vs CLI | Identical WAV + flags; parity test gates removing the CLI path |
| Raw-byte IPC edge cases | `len % 4 == 0` guard, `from_le_bytes`, WAV-from-bytes fallback |

---

## 8. Open decisions (maintainer sign-off)

1. **Confirm `whisper-server` ships for all runtime variants** (spike) vs. CLI fallback per-variant.
2. **Retain the `whisper-cli` one-shot path** as `engine="cli"` fallback for ≥1 release, then
   revisit. *Recommendation: retain.*
3. **Idle-unload default** (proposed 5 min) and whether to expose it in Settings.
4. **Parakeet**: apply the same persistent-server pattern later (sherpa-onnx has a server too) —
   follow-up, not P0.

---

## 9. Rollout

One PR (this branch): P0.0 measurement + `whisper_server.rs` manager/commands + provider rewire +
P1b preload + release-workflow bundling of `whisper-server`, with `engine` defaulting to
`"server"` and `"cli"` retained as fallback. Parakeet + later phases follow separately per
`handy-adoption.md`.
