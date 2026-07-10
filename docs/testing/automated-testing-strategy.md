# Verbatim AI — Automated Testing Strategy

Goal: stop testing the app by hand. Get automated coverage of **all** functionality and, above all, of **every transcription engine and every cleanup engine**, so a regression in any provider/permutation is caught before release.

Synthesized from a two-model strategy council (Gemini 3.1 Pro + Claude Sonnet 4.6) grounded in the current codebase.

## Why this is hard (and why manual QA is the bottleneck today)

Verbatim AI is unusually hostile to naive automation: two WebViews (`main` + transparent `overlay`), OS-level global hotkeys (`fn_hotkey.rs`, `tauri-plugin-global-shortcut`), exclusive audio-device locks (`cpal` + `getUserMedia`), several out-of-process sidecars (whisper-cli/server, sherpa-onnx, llama.cpp), and cloud edge functions. The strategy is to push almost everything **below** true E2E and reserve E2E for the few OS-boundary flows.

## Current state (baseline)

- **Vitest**: ~199 tests / ~20 files. An IPC-mock pattern already exists (`src/lib/recording-bridge.test.ts`, `src/lib/nativeAudio.test.ts` mock `@tauri-apps/api/core`).
- **Cargo**: `native_audio` unit tests (resampler/frame logic).
- **CI**: only `.github/workflows/release.yml` (tag-triggered build). **There is no per-PR test gate.**
- **Gaps**: zero coverage of real AI provider invocations, no engine matrix, no Tauri E2E, no updater/sidecar-lifecycle tests, no PR gating.

## 1. Test pyramid

| Layer | Tooling | Scope | Target | Runtime |
|---|---|---|---|---|
| **L0 Unit (JS)** | vitest | pure logic: `modeResolver`, `promptBuilder`, VAD math, stores, `hotkey.ts` state machine | ≥90% line on pure modules | <30 s |
| **L0 Unit (Rust)** | cargo test | `native_audio` ring/resample bounds, CLI-arg construction in `local_whisper`/`llama_cpp`, whisper-server lifecycle (mock clock) | — | <1 min |
| **L1 Integration** | vitest + `vi.mock('@tauri-apps/api/core')` | overlay state machine (Listening→Transcribing→Cleaning), every `invoke` path, provider selection | every invoke path | <2 min |
| **L2 Engine matrix** | vitest (node) + real sidecars/daemons | instantiate each provider, feed golden fixtures, assert output | every transcribe + cleanup engine | minutes (nightly) |
| **L3 E2E** | `tauri-driver` + WebdriverIO | 3–5 OS-boundary happy paths (window spawn, hotkey→record→paste, clipboard) | 3–5 flows only | 5–15 min/platform |

**L2 (engine matrix) is the highest-ROI layer** and should be built first — it directly targets the maintainer's ask and needs no Tauri driver.

## 2. Engine test matrix (the priority)

### Fixtures
- `fixtures/hello_world.16k.f32` — a 3 s, 16 kHz mono Float32 PCM of a known utterance ("hello world, this is a test").
- `fixtures/messy_transcript.txt` — a disfluent transcript ("umm, so like, print hello world in python, you know?").
- Generate the audio once (recorded or TTS) and commit it; it is the ground truth.

### Transcription engines → assert with Word Error Rate (WER)
Instantiate each provider directly, feed the fixture PCM, compute normalized WER (levenshtein over lowercased, punctuation-stripped tokens) against the expected string, and assert `WER < 0.15`.

Cover **every** engine:
- `SupabaseAIProvider` (cloud → Azure Whisper edge fn)
- `LocalWhisperProvider` — **both** execution modes: `whisper-cli` and warm `whisper-server`
- `ParakeetProvider` (sherpa-onnx)
- `whisper-stream` streaming sidecar (if/when the binary ships)

### Cleanup engines → assert with shape/regex (LLM output is nondeterministic)
Feed the messy transcript, assert the *shape*: positive match on the expected content and **negative** match on disfluencies. Never assert exact strings.
```ts
expect(out).toMatch(/print\(["']hello world["']\)/i);
expect(out).not.toMatch(/\b(umm|like|you know)\b/i);
```
Cover: `SupabaseAIProvider` (SSE), `OllamaProvider`, `LlamaCppProvider`.

### Composite routing
`getActiveProvider(mode)` pairs a transcriber + cleaner independently (`src/lib/ai/index.ts`). Test that e.g. `{transcribe: local-whisper, cleanup: ollama}` resolves to the right pair, and that per-mode overrides win — with the providers themselves mocked (this is L1, deterministic, runs on every PR).

### Availability gating (deterministic locally, exhaustive in CI)
Wrap each real-engine suite in `describe.skipIf(...)`:
- skip whisper/parakeet if the sidecar binary/model isn't present,
- skip Ollama if `fetch('http://127.0.0.1:11434')` fails,
- skip Supabase if `!process.env.SUPABASE_ANON_KEY`.
Local dev stays fast; the nightly CI job pre-seeds everything so nothing is skipped there.

### Skeletons
```ts
// src/lib/ai/localWhisper.engine.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { LocalWhisperProvider } from "./localWhisper";
import { wer } from "../../test/wer";

const pcm = new Float32Array(fs.readFileSync("fixtures/hello_world.16k.f32").buffer);

describe.skipIf(!fs.existsSync(process.env.WHISPER_CLI ?? ""))("LocalWhisper (cli)", () => {
  it("transcribes within 15% WER", async () => {
    const p = new LocalWhisperProvider({ tier: "tiny", engine: "cli" });
    const { text } = await p.transcribe({ audio: pcm, sampleRate: 16000, mode: null });
    expect(wer("hello world this is a test", text)).toBeLessThan(0.15);
  }, 30_000);
});
```
```ts
// src/lib/ai/ollama.engine.test.ts
const up = await fetch("http://127.0.0.1:11434").then(r => r.ok).catch(() => false);
describe.skipIf(!up)("Ollama cleanup", () => {
  it("strips disfluencies", async () => {
    const out = await collect(new OllamaProvider().cleanup({ text: MESSY, mode: null }));
    expect(out).not.toMatch(/\b(umm|like|you know)\b/i);
    expect(out).toMatch(/hello world/i);
  }, 20_000);
});
```

## 3. Tauri E2E

**Framework: `tauri-driver` + WebdriverIO** on both platforms (uniform API). Playwright can *not* attach to macOS WKWebView; it can attach to Windows WebView2 via CDP, so keep Playwright only as a Windows fallback if ever needed.

- **Two windows**: WDIO sees them as handles — `const [main, overlay] = await browser.getWindowHandles()`; `switchToWindow` to assert the overlay DOM.
- **Global hotkey** can't be driven by `browser.keys()` (it only reaches the focused WebView, not the OS). Add a **`#[cfg(debug_assertions)]`** command `test_simulate_hotkey({action:"down"|"up"})` that emits the same internal `hotkey:down/up` the plugin/tap would, exercising the real `src/lib/hotkey.ts` flow without the OS hook.
- **Microphone**:
  - WebAudio path — launch the driver with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=fixtures/hello_world.wav`.
  - Native cpal path — a `#[cfg(debug_assertions)]` branch in `arm_native_capture` that feeds fixture PCM into the ring buffer instead of opening a real device (also reusable as a `test_inject_native_pcm` command).
- **Paste**: `enigo` has no foreground app in CI. Assert via the OS clipboard (`navigator.clipboard.readText()`) instead of a third-party target.
- **Linux/headless**: run under `xvfb` (or use `macos`/`windows` runners where the WebView is native).

### Skeleton
```ts
it("hotkey → record → clipboard", async () => {
  await browser.execute(() => window.__TAURI_INTERNALS__.invoke("test_simulate_hotkey", { action: "down" }));
  const [main, overlay] = await browser.getWindowHandles();
  await browser.switchToWindow(overlay);
  await expect($(".pill-listening")).toBeDisplayed();
  await browser.execute(() => window.__TAURI_INTERNALS__.invoke("test_simulate_hotkey", { action: "up" }));
  await browser.switchToWindow(main);
  await browser.waitUntil(async () =>
    (await browser.execute(() => navigator.clipboard.readText())).toLowerCase().includes("hello world"),
    { timeout: 10_000 });
});
```

## 4. The hard parts

- **Sidecar download/verify/extract** (`local_whisper.rs`, `parakeet.rs`, `llama_cpp.rs`): never download during a test. A `pnpm test:warm-cache` script pre-seeds the smallest viable models (Whisper `tiny` ~75 MB, Parakeet v3) into a cache restored via `actions/cache`. Unit-test the extract/checksum/quarantine logic directly against a tiny committed archive fixture.
- **Whisper-server warm lifecycle + idle unload** (`whisper_server.rs`): a Rust `cargo test` that spins the manager with a mock clock, advances past the idle timeout, and asserts the child is killed and the port freed. (Note: the existing `concurrent_ensure_spawns_one_server` test is flaky under full-suite parallelism — quarantine/serialize it.)
- **Native cpal capture**: the `test_inject_native_pcm` backdoor above makes the whole VAD/framing/session path testable with zero audio hardware.
- **Auto-updater** (`src/lib/updater.ts`): stand up a local `latest.json` server (a tiny Express/Node handler at `localhost:PORT`) and point the updater endpoint there via an env override; assert the manual-required/translocation guard and the version-compare logic. Do not hit real GitHub releases.
- **Cloud edge functions**: `supabase start` + `supabase functions serve` in the runner; use the local anon key. Alternatively record/replay fixtures for a fully offline PR gate.

## 5. CI design

**Job A — Fast PR gate (every PR, Ubuntu, < 4 min):** `eslint`, `tsc --noEmit`, `cargo test`, `vitest run` (L0 + L1 only, real engines skipped). This is the gate that's missing today and should land first.

**Job B — Engine + E2E matrix (nightly + manual, macOS + Windows):**
1. restore the pre-seeded model/sidecar cache,
2. start `supabase` local + `ollama`,
3. `vitest run --project engine-matrix` (all real engines, nothing skipped),
4. `wdio run` for the 3–5 E2E flows.
Quarantine OS-level flakes with `retry: 2`; keep a flaky-test allowlist so a known flake never blocks nightly.

## 6. Test-only backdoors to add (small, `#[cfg(debug_assertions)]`)

- `test_simulate_hotkey({action})` — emit `hotkey:down/up`.
- `test_inject_native_pcm({samples})` — push fixture PCM into the native ring buffer.
- fixture-file branch in `arm_native_capture` / a WebAudio getUserMedia mock hook.
- env override for the updater endpoint.

These never ship in release builds and are the key that unlocks deterministic E2E.

## 7. Phased implementation plan

1. **PR gate + engine matrix (L0/L1/L2).** Add the fast PR workflow; add the `wer` util + fixtures; write the transcription (WER) and cleanup (shape) engine tests with `skipIf`. Highest ROI, no Tauri driver.
2. **Rust test backdoors + `test:warm-cache`.** Land the debug commands + the cache-seeding script; add sidecar-extract and whisper-server-lifecycle cargo tests.
3. **Tauri E2E.** Wire `tauri-driver` + WebdriverIO + the 3–5 flows; add the nightly matrix job (macOS + Windows) with Supabase/Ollama local.
4. **Updater + cloud coverage.** Local `latest.json` server; Supabase-local edge-function tests.

## Acceptance

- A regression in any single transcription or cleanup engine (or any composite pairing) fails a nightly run with a clear signal.
- Every PR runs lint + types + unit + IPC-integration in < 4 min.
- The core flow (hotkey → record → transcribe → cleanup → paste) is covered by at least one green E2E flow per platform.
- No test depends on a human pressing `fn` or listening to audio.
