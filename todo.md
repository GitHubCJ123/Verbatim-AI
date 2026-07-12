# TODO / Roadmap

Resumable backlog. The two big plans have full detail in `docs/` — this file
is the index so a future session can pick up where we left off.

- Simplification detail → `docs/proposals/simplification-plan.md`
- Automated testing detail → `docs/testing/automated-testing-strategy.md`

---

## Recently shipped (done)

- **Single-instance window** — `tauri-plugin-single-instance` (relaunch focuses the existing window).
- **Near-zero-latency push-to-talk** — warm `cpal` capture engine + ring buffer + pre-roll; native **"Fast"** capture is the default with a WebAudio fallback (PRs #51, #52). This closed the old "~1s start delay".
- **Single-key / modifier hold-to-talk on macOS** — `fn` and right ⌘ (hold to record, release to stop), with a simplified hotkey selector.
- **macOS auto-update translocation guard** (PR #49) + **llama.cpp download-race fix** (PR #50).
- **Automated testing Phase 1** — the per-PR CI gate (`.github/workflows/pr-checks.yml`) + the engine-test matrix (WER golden tests, mocked-invoke contracts, `test:engines`) (PR #55).
- **Simplification Tier A** — `AIProvider` → `Transcriber`/`Cleaner` split + Ollama health fix (#56), collapse capture flags to one `recordingEngine` enum (#57), shared Rust `runtime_assets` sidecar module (#58), un-register superseded non-PCM commands (#59).

---

## Next up

### Simplification — Tier B (product decisions) → `docs/proposals/simplification-plan.md`
- [ ] **B1** Hide the whisper engine (server/cli) toggle from the UI; keep the internal `auto`.
- [ ] **B2** Hide the whisper compute (cpu/cuda/vulkan) toggle; auto-detect, keep an internal override.
- [ ] **B3** Pick ONE local cleanup engine — recommend keeping **Ollama** and demoting/removing llama.cpp.
- [ ] **B4** Resolve the 3-deep live-preview stack — ship exactly one path (true streaming) or drop both `livePartial` + `trueStreaming` until one is shippable.
- [ ] **B5** Trim the Whisper tier catalogue (~3 recommended tiers + custom drop-in).
- [ ] **B6** Collapse Settings → Model into **Recommended + Advanced**.

### Simplification — Tier C → `docs/proposals/simplification-plan.md`
- [ ] **C1** Demote/drop Parakeet (advanced or plugin). · **C2** Unify the sidecar progress-event schema. · **C3** Unify cloud vs local cleanup prompt construction. · **C4** Typed settings store + migration for the `sw.*` flags. · **C5** Centralize `CLOUD_FEATURES_ENABLED` gating in one resolver.

### Automated testing — Phase 2/3/4 → `docs/testing/automated-testing-strategy.md`
- [ ] **Phase 2** — Rust test backdoors (`test_simulate_hotkey`, `test_inject_native_pcm`), a `test:warm-cache` script, sidecar-extract + whisper-server-lifecycle cargo tests, and real Rust integration golden tests for the invoke-based engines (whisper-cli/server, parakeet, llama.cpp) that can't run in Node.
- [ ] **Phase 3** — Tauri E2E via `tauri-driver` + WebdriverIO (dual-window, hotkey/mic backdoors, clipboard assertions) + a nightly full-engine-matrix CI (macOS + Windows, cached models, local Supabase/Ollama).
- [ ] **Phase 4** — Auto-updater tests (local `latest.json` server) + Supabase-local edge-function tests.

### macOS auto-update — permanent fix
- [ ] **Developer ID code-signing + notarization** in `release.yml` so the app isn't quarantined/translocated and auto-update lands in `/Applications`. #49 shipped the interim in-app guard (+ `xattr` docs). Needs an Apple Developer account and `APPLE_*` GitHub secrets.

---

## Open GitHub issues

- [ ] **#53** — Fully Rust-first push-to-talk hot path (start capture in the `fn` tap callback, before any JS). Includes engine nits **N4** (pre-size the long-recording buffer so the realtime cpal callback avoids amortized `Vec` growth) and **S2** (emit `native_audio:error` on mid-session device loss).
- [ ] **#33** — True token-level streaming transcription. Validated on macOS; the Windows CPU/CUDA `whisper-stream` sidecar build is deferred.
- [ ] **#40** — Full multi-architecture model catalogue (GGUF multi-arch loader for Handy-parity breadth: Canary, Voxtral, Qwen3-ASR, Moonshine, …).
- [ ] **#13** — Activate Edge Function hardening: enable Supabase anon sign-ins, apply migration `0014`, redeploy `transcribe`/`cleanup`, set `EDGE_HARDENING_ENABLED=true`. Code merged but gated off.
- [ ] **#22** — Reintroduce cloud AI models + account sync behind a subscription (product decisions; depends on #13).
