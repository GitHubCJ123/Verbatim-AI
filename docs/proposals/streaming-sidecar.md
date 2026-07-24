# True token-level streaming transcription — dedicated streaming sidecar

Issue: [#33](https://github.com/GitHubCJ123/Verbatim-AI/issues/33) — follow-up
from #23 (P2.6) and #36. Status: **design + non-breaking app-side scaffold +
Settings UI toggle + guarded CI packaging hook**.
The release pipeline now attempts to build and bundle the streaming sidecar when
its source target is present; the first tagged release that includes the source
still needs archive-level validation.

## 1. Problem & feasibility recap

Verbatim's live-partial preview (`sw.transcribe.livePartial`, #32/#36) is
**chunked pseudo-streaming**: `src/lib/transcribe/segmenter.ts` accumulates the
live 16 kHz mono frames and, on a VAD boundary or ~1.75 s cadence,
re-transcribes the whole audio-so-far (or a rolling window) through the batch
engine. `src/lib/transcribe/coordinator.ts` serializes those overlapping
request/response calls. It works, but it re-runs a full batch transcription per
partial — it is not token-level streaming.

Feasibility findings already established (see #36):

- **`whisper-stream`** exists in whisper.cpp and emits incremental output, but
  it is an **SDL2 microphone example**. It opens the mic itself and selects a
  capture device; it does not consume Verbatim's existing AudioWorklet PCM
  frames. Wiring it directly would add SDL2, device-selection and
  terminal-output-parsing work, and would fight Verbatim for the microphone.
- **`whisper-server`** (the warm resident model we already bundle, see
  `src-tauri/src/commands/whisper_server.rs`) is **request/response only**:
  `/inference` + `/load`, no documented SSE/token partial endpoint.
- **sherpa-onnx / Parakeet** has streaming-capable APIs, but Verbatim ships the
  **offline** `sherpa-onnx-offline` sidecar. True Parakeet streaming needs a new
  **online** model bundle plus a new stream protocol.

Conclusion: true streaming needs a **streaming-capable engine fed by Verbatim's
own PCM frames**, emitting structured incremental partials. None of the binaries
we ship today do that. So we introduce a dedicated **streaming sidecar**.

## 2. Proposed design

### 2.1 The streaming sidecar (a separate process)

A dedicated, **headless** sidecar process that:

1. **Input:** reads **16 kHz mono f32 little-endian PCM frames over stdin**
   (no mic, no SDL2). Framing is length-prefixed so the reader stays in sync:

   ```
   [u32 LE sample_count][sample_count × f32 LE]   ← one audio chunk
   ...
   [u32 LE 0]                                     ← finalize marker (flush)
   ```

   A `sample_count` of `0` is the **finalize marker**: the sidecar flushes its
   decoder, emits a final transcript, and exits on stdin EOF.

2. **Output:** emits **line-delimited JSON** on stdout, one event per line:

   ```json
   {"type":"partial","text":"the quick brown"}
   {"type":"partial","text":"the quick brown fox"}
   {"type":"final","text":"The quick brown fox."}
   ```

   `partial` events are the live, revisable hypothesis; `final` is emitted once
   after the finalize marker. Unknown fields are ignored (forward-compatible).
   `stderr` is for diagnostics only and is never parsed.

This protocol is transport-simple (stdin/stdout pipes, no socket/port
allocation), trivially fakeable in tests, and matches how the app already owns
the audio (AudioWorklet `onFrame` in `src/lib/audio.ts`).

### 2.2 Engine options evaluated

| Option | Summary | Pros | Cons |
| --- | --- | --- | --- |
| **(a) Headless C++ whisper.cpp streaming wrapper** | Small C++ program linking whisper.cpp's streaming state (the non-SDL2 half of the `whisper-stream` example), reading PCM from stdin, printing JSON-line partials. Built + bundled exactly like `whisper-cli`/`whisper-server`. | Reuses the whisper.cpp version, GGML model files and per-variant (cpu/cuda/vulkan/metal) runtime layout we **already build in `release.yml`**. No SDL2. Separate process ⇒ **no in-process linking** into the app, so the Windows `bindgen`/`whisper-rs` linkage constraint does not apply. | Requires a small amount of new C++ + a CMake target in CI. |
| **(b) Rust `whisper-rs` streaming sidecar** | A standalone Rust binary using `whisper-rs` streaming, built in CI. | Pure Rust, easy stdin/stdout + JSON. Separate binary ⇒ still avoids linking `whisper-rs` into the **main app** (the thing the repo avoids for Windows bindgen reasons). | Adds a **second** whisper build toolchain and its own model plumbing; duplicates model discovery the C++ runtimes already provide. |
| **(c) sherpa-onnx online (Parakeet streaming)** | Ship the online sherpa-onnx runtime + an online model, feed PCM, read partials. | Genuinely streaming ASR designed for it. | New **online** model bundle + download UX + a different runtime; largest packaging delta. |

### 2.3 Recommendation

**Option (a): the headless C++ whisper.cpp streaming wrapper.** It maximises
reuse of the runtime packaging, model files and per-GPU-variant selection that
`release.yml` and `local_whisper.rs` already implement, keeps a single whisper
version, avoids SDL2, and — being a separate process — sidesteps the
Windows-bindgen reason the repo avoids linking whisper into the main app. The
only new CI work is a small C++ source + CMake target; everything else
(discovery, spawning, streaming, fallback) is shared with this scaffold and is
engine-agnostic. Option (b) is the fallback if the C++ target proves awkward in
CI; the app-side manager and protocol below are identical for (a) and (b).

### 2.4 App-side integration

```
AudioWorklet onFrame (16 kHz f32)                     [src/lib/audio.ts]
        │  (opt-in sink, default off)
        ▼
StreamingTranscriber (TS client)                      [src/lib/transcribe/streamingClient.ts]
        │  batches frames, invoke("push_streaming_frames", …)
        ▼
StreamingSidecarState / StreamingSession (Rust)       [src-tauri/src/commands/streaming_sidecar.rs]
        │  length-prefixed f32 → sidecar stdin
        ▼
   streaming sidecar (whisper.cpp headless)  ── JSON lines on stdout ──┐
        ▲                                                              │
        │  Rust stdout reader task parses JSON, emits Tauri event      │
        └──────────────  "stream:partial" { sessionId, kind, text } ◄──┘
        ▼
Overlay listener → setPartialText(...)                [src/overlay/Overlay.tsx]
```

- **Rust manager** `streaming_sidecar.rs` mirrors `whisper_server.rs`'s
  **single-active-process + terminate-on-drop + best-effort stop on app exit**
  discipline, but deliberately **does NOT copy `whisper_server.rs`'s idle
  eviction / warm-cache-key reuse** — a streaming session is scoped to a single
  recording, not a long-lived warm model, so it is created on start and torn
  down on stop/finish. It exposes a **testable core** (`StreamingSession`) that
  spawns the child with piped stdin/stdout, writes length-prefixed f32 frames
  via `write_all`, and forwards parsed `StreamEvent`s to a `tokio::sync::mpsc`
  sender. The stdout reader uses a **buffered line reader** so JSON events split
  across pipe reads are reassembled; malformed lines are skipped, not fatal. The
  Tauri command layer wires the sender to `AppHandle::emit("stream:partial", …)`
  with the `sessionId` attached. Commands: `is_streaming_sidecar_available`,
  `start_streaming_session`, `push_streaming_frames`, `finish_streaming_session`,
  `stop_streaming_session`. `stop`/`finish` are **idempotent**.
- **TS client** `StreamingTranscriber` buffers `onFrame` frames and flushes on a
  short cadence (default 200 ms) via `push_streaming_frames`, coalescing frames
  into one push to avoid a per-frame IPC storm. It `listen`s for
  `stream:partial` and calls back into the overlay with `{kind, text}` **only
  for the matching `sessionId`**; `finish` **drains any buffered frames first**,
  then sends the finalize marker exactly once and resolves with the final text.
  Pushes after `finish`/`stop` are ignored (no late-frame race). The client
  never throws into the audio callback — a rejected `start`/`push` is caught so
  the overlay can fall back.
- **Overlay** wires a frame sink to the client **only** when
  `sw.transcribe.trueStreaming === "1"` **and** the sidecar is available.
  Partials paint into the existing `partialText` state (same UI slot the chunked
  path uses). The final full-quality stop→transcribe path is **unchanged** and
  still replaces the partial.
- **Settings UI** (Settings → Recording → "True token-level streaming") exposes
  the opt-in toggle plus a live availability badge — `Ready` once
  `is_streaming_sidecar_available` resolves `true` for the active compute
  variant, or `Not available yet — falls back to live preview` otherwise. The
  probe runs once on mount; the switch can be turned on ahead of the sidecar
  binary being bundled since the overlay always falls back gracefully. The row
  is also registered in `settingsRegistry.ts` so it's reachable from the Cmd+K
  command palette.

### 2.5 Non-breaking guarantees & graceful fallback

- New opt-in flag **`sw.transcribe.trueStreaming`, default OFF**. With it off,
  zero new code runs and the existing pipeline is byte-for-byte unchanged.
- On start, if the flag is on but `is_streaming_sidecar_available` is `false`
  (no sidecar binary bundled yet) **or** session start throws, the overlay
  **falls back** to the existing chunked live-partial path (or, if that too is
  off, to no preview). The final stop→transcribe path is never affected.
- The sidecar is a **separate process**: a crash cannot take down the app; the
  reader task ends, the session is dropped, and the next recording retries or
  falls back.
- Precedence: `trueStreaming` (if available) supersedes `livePartial` for the
  *preview only*, so we never run both preview engines at once.

## 3. Test plan

Everything below runs **without the real sidecar binary** — a fake sidecar
(a Python/shell script that reads the framed stdin and prints canned JSON
partials) stands in, mirroring the fake-`whisper-server` pattern already in
`whisper_server.rs`'s tests.

### 3.1 Rust manager (`cargo test`, unix)

A `fake-streaming-sidecar.py` reads the length-prefixed stdin protocol and, per
audio chunk, prints `{"type":"partial","text":"partial <n>"}`; on the finalize
marker prints `{"type":"final","text":"final transcript"}`. Tests construct a
`StreamingSession` directly against the fake with an mpsc receiver and assert:

1. **Partial streaming** — pushing N chunks yields N `partial` events in order.
2. **Finalize** — `finish()` produces exactly one `final` event with its text.
3. **Frame encoding** — the fake echoes the sample count it read back into the
   partial text, proving frames are length-prefixed correctly.
4. **Stop/terminate** — `stop()` terminates the child and the reader task ends;
   no events arrive afterward (stale-partial guard).
5. **Missing binary** — `is_streaming_sidecar_available` is `false` when no
   sidecar is present (drives the app-side fallback).
6. **Fragmented JSON** — a fake that emits a `partial` line in two stdout writes
   still yields one reassembled event (buffered line reader).
7. **Malformed / noisy lines** — junk / non-JSON stdout lines are skipped, not
   fatal; valid events after them still arrive.
8. **EOF before final** — a fake that exits without a `final` line yields the
   partials it did emit and then completes without hanging.
9. **Empty finalize** — `finish()` with no frames pushed still yields a single
   `final` event and tears down cleanly (very-short/empty-audio case).

### 3.2 TS client (`vitest`)

`streamingClient.test.ts` mocks `@tauri-apps/api/core` `invoke` and
`@tauri-apps/api/event` `listen`. Asserts:

1. Frames are batched and flushed via `push_streaming_frames` on cadence.
2. `stream:partial` events with the matching `sessionId` invoke the `onPartial`
   callback; events for a **different** sessionId are ignored (stale guard).
3. `finish()` calls `finish_streaming_session` and resolves with the final text.
4. A rejected `start`/`push` surfaces so the overlay can fall back; the client
   never throws into the audio callback.

### 3.3 No-regression checks

- Default-off assertion: `isTrueStreamingEnabled()` is `false` when the key is
  unset; existing `livePartial` and stop→transcribe tests are untouched and
  still green.
- Overlay wiring is guarded by both the flag and availability, so the plain
  push-to-talk path wires nothing (same discipline as `onFrame`/auto-stop).
- Full suite gates: `cargo check`, `cargo test`, `tsc --noEmit`,
  `vitest run src/`, `pnpm lint` all pass.

## 4. CI / packaging status

`release.yml` now has a guarded packaging hook for **building and bundling the
streaming sidecar binary** per platform/variant, next to `whisper-cli` /
`whisper-server`. For each existing runtime archive it configures
`sidecars/whisper-stream` with `-DWHISPER_ROOT=<the whisper.cpp build/runtime
root used for whisper-cli>`, builds the `whisper-stream` target, and stages the
resulting `whisper-stream` / `whisper-stream.exe` beside `whisper-cli` before the
archive is created. macOS also includes the same executable-bit and `@rpath`
fix-up pass used by the other bundled whisper binaries.

The hook is intentionally **soft-guarded** like `whisper-server`: if the source
target is absent or the sidecar build is not usable for a variant, CI emits a
warning and still publishes the release. The app-side scaffold then reports the
sidecar unavailable and **falls back**, so there is no user-visible regression.
A real tagged release run that includes the source target is still required to
validate the produced archives and confirm `is_streaming_sidecar_available`
flips to `true` for each runtime variant.

## 5. GPT-5.5 self-critique (incorporated)

A GPT-5.5 rubber-duck review of an earlier draft raised the following; each is
now reflected in the design above and the test plan:

- **Finish/push ordering race (P0).** A pending 200 ms flush could land after
  the finalize marker. → `finish()` **drains buffered frames first, then sends
  the finalize marker exactly once**; pushes after finish/stop are ignored
  (§2.4). Covered by a client test.
- **Per-frame IPC storm.** Invoking Rust per 480-sample frame would flood IPC.
  → The client **batches/coalesces** frames and flushes on a ~200 ms cadence
  (§2.4).
- **Stale partials after stop (P0).** Partials from a superseded recording could
  paint over the next one. → Session-scoped `sessionId` on every event; the
  client and overlay ignore mismatched sessions; the overlay **removes its
  listener and stops the session** on stop/cancel/teardown; `stop()` terminates
  the child and the reader task (§2.4, §3.1/3.2).
- **Testability coupling to Tauri.** Emitting Tauri events directly from the
  reader would make the manager untestable. → The core forwards to an **mpsc
  sender**; only the thin command layer emits Tauri events, so tests observe the
  channel (§2.4, §3.1).
- **Fallback must be total (P0).** A missing/failed sidecar must never break the
  final transcription. → Availability check + try/catch fallback to the chunked
  path at setup, separate process, final stop→transcribe path untouched (§2.5).
  A mid-stream sidecar failure degrades to "no preview update" (best-effort);
  the final path still runs — this is the honest, non-regressive tradeoff rather
  than a complex hot-swap back to chunked mid-recording.
- **Framing desync / partial reads (P1).** Raw PCM streaming risks reader/writer
  desync; JSON lines can split across pipe reads. → Length-prefixed frames +
  explicit finalize marker; a **buffered line reader** reassembles JSON events;
  malformed lines are skipped; `write_all` for complete frame writes (§2.1,
  §2.4). Covered by fragmented/malformed-JSON and EOF-before-final tests.
- **Wrong bits of `whisper_server.rs`.** Idle eviction and warm-cache-key reuse
  fit a long-lived warm model, not a per-recording session. → The streaming
  manager keeps only single-active-process + terminate-on-drop + stop-on-exit,
  and **omits idle eviction / cache-key reuse** (§2.4).
- **Lifecycle edge cases (P1).** Empty/very short audio, rapid start/stop,
  cancel, app exit mid-stream. → `start`/`finish`/`stop` are idempotent; empty
  finalize emits only a final; teardown terminates the child (§2.4). Covered by
  Rust and client tests.
- **Double preview engines.** Running chunked + true streaming together wastes
  CPU and fights over `partialText`. → `trueStreaming` (when available)
  supersedes `livePartial` for the preview when active (§2.5).
