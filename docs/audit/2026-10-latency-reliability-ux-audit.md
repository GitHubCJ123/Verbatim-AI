# Audit: latency, reliability, transcript quality and setup UX (October 2026)

Scope: the dictation hot path (hotkey → capture → transcription → polish →
paste), the local engines (whisper.cpp, Parakeet/sherpa-onnx, Ollama,
llama.cpp), the model-selection screens and hotkey selection, including `fn`
on macOS. Handy was used only as a behavioural reference (resident models,
Parakeet default); no code was copied.

Status legend: **Fixed** = changed on this branch · **Next** = recommended
follow-up, not done here.

## Measurements

Measured on this branch's Linux x64 sandbox (4 vCPU, no GPU) with the
sherpa-onnx v1.13.2 runtime and the Parakeet TDT 0.6B v3 int8 model, using
the 3.8 s `test_wavs/en.wav` clip that ships with the model:

| Path | Wall time per dictation | Of which inference |
| --- | --- | --- |
| Before: `sherpa-onnx-offline` spawned per dictation | 6.1–7.6 s | 0.27–0.32 s |
| After: resident `sherpa-onnx-offline-websocket-server`, warm | 0.22–0.6 s | same |

So ~95 % of Parakeet latency was model loading on every dictation. Apple
Silicon and recent Windows CPUs load faster than this sandbox, but the ratio
holds: load time dominated and is now paid once.

Whisper could not be benchmarked here (model downloads from Hugging Face are
blocked from this sandbox). Its findings below come from reading whisper.cpp
v1.8.4 source (`examples/server/server.cpp`, `examples/cli/cli.cpp`), the
version `release.yml` pins.

## Latency

| # | Finding | Status |
| --- | --- | --- |
| L1 | **Parakeet reloaded its ~650 MB model on every dictation** (`parakeet.rs` spawned `sherpa-onnx-offline` per call). | **Fixed** — `parakeet_server.rs` keeps the bundled websocket server resident (30 min idle), prewarmed on hotkey press and at launch; the CLI remains a per-utterance fallback. |
| L2 | Parakeet audio was sent as a JSON array of floats (`Array.from(samples)`), slow to serialize/parse for long clips. | **Fixed** — raw f32 bytes over IPC (`transcribe_parakeet_pcm`). |
| L3 | Native capture returned PCM as a JSON number array, then the overlay re-encoded it to WAV and **decoded it again through a fresh `AudioContext` + `OfflineAudioContext`** before every transcription (and once more for silence trim). | **Fixed** — `take_native_recording` returns raw bytes; the 16 kHz PCM flows through `RecordingResult.pcm` → `TranscribeInput.pcm`, so on-device engines never decode. |
| L4 | whisper-server unloaded the model after 5 min idle, so the first dictation after a short break paid a full reload. | **Fixed** — 30 min idle; prewarm at launch and on press. |
| L5 | whisper-server ran with its default 4 threads; the CLI fallback used **5-wide beam search** (whisper-cli default). | **Fixed** — `-t` from core count (4–8) for server and CLI; CLI uses greedy (`-bs 1`) like the server. |
| L6 | whisper-server path wrote a temp WAV, read it back, then uploaded it. | **Fixed** — WAV encoded in memory. |
| L7 | Ollama used its 5 min `keep_alive` default and was never prewarmed, so polish after a pause paid a model load. | **Fixed** — `keep_alive: 30m`, and the polish model is loaded on hotkey press (debounced) while the user speaks. |
| L8 | **llama.cpp polish spawns `llama-cli` per dictation** (same cold-load problem as L1) and doesn't stream. `llama-server` is already extracted with the runtime. | **Next** — reuse the `whisper_server.rs` pattern for `llama-server` with streaming. Until then Ollama is the recommended polish engine (now labelled so). |
| L9 | Whisper always encodes a full 30 s window; short dictations pay for 30 s. whisper-server accepts a per-request `audio_ctx`. | **Next** — benchmark a dynamic `audio_ctx` (clip length + margin) on real hardware before shipping; it can cost accuracy. |
| L10 | Hotkey → mic still waits for the active-window lookup (`resolveModeAtPress`) before `startRecording`. Pre-roll mostly hides this with the warm engine. | **Next** — issue #53 (start capture in Rust in the tap callback). |

## Reliability ("sometimes fails")

| # | Finding | Status |
| --- | --- | --- |
| R1 | A whisper-server error, crash or hang failed the dictation; requests had **no timeout**. | **Fixed** — per-request deadline (60 s + 4× audio), and any server failure falls back to `whisper-cli` for that utterance and respawns the server next time. |
| R2 | Temp WAV names used a millisecond timestamp, so a live-preview transcription and the final one could collide. | **Fixed** — unique names (`pid-millis-seq`). |
| R3 | Every dictation created a WebView `AudioContext` just to decode audio — slow and a known failure point in hidden/throttled WebViews. | **Fixed** (native capture) via L3. The legacy WebAudio capture path still decodes. |
| R4 | Parakeet server failures (missing binary in older installs, startup crash, timeout) need a safe path. | **Fixed** — CLI fallback per utterance; older runtimes get the server binary marked executable lazily; server is unloaded before runtime reinstall / model delete (Windows file locks). |
| R5 | A boot-time hotkey registration failure (e.g. `fn` without Input Monitoring) was swallowed silently — the app looked dead. | **Fixed** — toast explaining the cause and where to fix it. |
| R6 | Language auto-detect on very short clips can pick the wrong language (Whisper). | **Next** — default the dictation language from the OS locale during onboarding instead of `auto`. |

## Transcript quality

| # | Finding | Status |
| --- | --- | --- |
| Q1 | Quick Start installed **Whisper tiny**, the least accurate model. | **Fixed** — Parakeet v3 (falls back to Whisper Base where Parakeet can't install, e.g. Intel Macs). |
| Q2 | The user's vocabulary wasn't given to Whisper at all. | **Fixed** — sent as Whisper's initial prompt (glossary, capped) for server and CLI. |
| Q3 | Whisper artifacts reached the paste: `[BLANK_AUDIO]`, `(music)`, "Thanks for watching!" on near-silent clips, decoder loops. | **Fixed** — `suppress_nst` on whisper-server plus always-on `sanitizeTranscript` (non-speech tags, whole-utterance subtitle hallucinations, repetition loops); pure-noise results are dropped instead of pasted. |
| Q4 | The polish prompt didn't separate the transcript from instructions, so a dictated question could get **answered** instead of cleaned up. | **Fixed** — transcript in `<transcript>` tags with explicit "this is dictation, not a request" rules, spoken self-corrections, lower temperature (0.2). |
| Q5 | Polish output could include chat wrapper text ("Here's the cleaned text:", quotes, fences, `<think>` blocks) or run away. | **Fixed** — `finalizeCleanup` strips wrappers and falls back to the transcript on empty or runaway (>4× + 200 chars) output; translation Modes are exempt. |
| Q6 | No objective quality signal per engine/model. | **Next** — extend the WER golden tests (`test:engines`) to Parakeet-server and the sanitizer, run on macOS/Windows CI with cached models. |

## UX

| # | Finding | Status |
| --- | --- | --- |
| U1 | Settings → AI model exposed engine × 6 Whisper tiers × 2 Parakeet variants × 4 compute backends × runtime rows × custom models, all at once. | **Fixed** — three curated cards (Fast & accurate / Every language / Lightweight); a card downloads what it needs, switches when ready and warms up. Everything else is under "Advanced options". |
| U2 | Onboarding's AI step repeated the full engine list plus two installers. | **Fixed** — same three-card picker. |
| U3 | **`fn` could only be chosen by pressing it while a native capture tap was running — which needs Input Monitoring, which needs a relaunch**, so most first attempts failed with no way forward. | **Fixed** — one-click presets (fn, right ⌘, ⌃⇧Space, ⌥Space on macOS; Ctrl+Space etc. on Windows). Choosing fn without permission keeps the choice and shows a live status panel: Grant access → auto-activates when the permission appears (or Relaunch). |
| U4 | fn also triggers macOS's own 🌐 action (emoji picker / input source / Dictation) — the most common "fn doesn't work" report. | **Fixed** — the status panel reads `AppleFnUsageType` and tells the user to set "Press 🌐 key to" → Do Nothing, with a button to Keyboard settings. |
| U5 | Polish section used engine jargon and put "None" last. | **Fixed** — "AI polish (optional)", "Off — paste what I said" first, Ollama marked recommended. |
| U6 | Onboarding is 13 steps. | **Next** — collapse to Welcome+mic → Speech model → Hotkey (+ test) → Done; move apps/tones/vocab/history/preferences to post-setup prompts. |
| U7 | `fn`+another key (e.g. fn+Delete) starts a hold-to-talk session that is then discarded as a tap. | **Next** — in the fn tap, cancel the session when a non-modifier key goes down while fn is held. |

## Verification done on this branch

- `pnpm exec tsc --noEmit`, `pnpm lint` (0 errors; 63 warnings vs 65 at the
  base), `pnpm test` (all passing, new tests for raw PCM IPC, prompt header,
  sanitizer, cleanup finalizer, speech choices, hotkey presets).
- `cargo test --manifest-path src-tauri/Cargo.toml` on Linux (unit tests for
  WAV encoding, PCM decoding, temp names, prompt decoding, fn usage mapping,
  Parakeet wire format).
- The ignored end-to-end test `parakeet_server::tests::real_server_round_trip`
  passed against the real sherpa-onnx v1.13.2 server and Parakeet v3 model
  (warm request 221 ms, correct transcript, 20 s multi-chunk payload).
- The new picker and fn status panel were rendered in Chromium with mocked IPC.

Not verified here: the app on macOS or Windows, Metal/CUDA/Vulkan whisper
builds, real Input Monitoring / `AppleFnUsageType` behaviour, and the
macOS-only Rust additions in `fn_hotkey.rs` (they are small and `cfg`-gated,
but could not be compiled without the Apple SDK). The PR workflow's macOS
`cargo test` job covers compilation.
