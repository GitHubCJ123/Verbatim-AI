# whisper-stream — headless streaming transcription sidecar (issue #33)

`whisper-stream` is the streaming ASR sidecar for Verbatim AI's **true
token-level streaming** path (issue [#33](https://github.com/GitHubCJ123/Verbatim-AI/issues/33),
design: [`docs/proposals/streaming-sidecar.md`](../../docs/proposals/streaming-sidecar.md)).

It is a small, **headless** C++ program that links whisper.cpp's public C API.
Unlike whisper.cpp's `examples/stream`, it has **no SDL2 and never touches the
microphone** — the app owns the audio and feeds PCM in over stdin. The app-side
manager that spawns it is already merged
(`src-tauri/src/commands/streaming_sidecar.rs`); this directory is the binary
that manager launches.

> Clean-room: this is an original implementation written against
> `whisper.cpp/include/whisper.h`. It does not copy the upstream `stream`
> example. whisper.cpp is MIT-licensed; only its documented public API is used.

---

## Protocol (the contract with the Rust manager)

Invocation:

```
whisper-stream -m <ggml-model.bin> [-fa] [-l <lang>] [-t <threads>] [--window-ms N] [--step-ms N]
```

| Flag | Meaning |
| --- | --- |
| `-m <path>` | **Required.** Standard whisper.cpp GGML `.bin` model (the same files the app already downloads for `whisper-cli`). |
| `-fa` | Enable flash attention. The manager passes this for the **CUDA / Metal** variants (matching the `whisper-cli` path). |
| `-l <lang>` | Language code, or `auto` (default). After the first decode the detected language is **locked** so partials don't flip languages mid-recording. |
| `-t <n>` | Decode threads (default `min(4, hardware_concurrency)`). |
| `--window-ms N` | Rolling context-window length (default `10000`). |
| `--step-ms N` | Emit a partial after this much new audio (default `2000`). |

The manager only relies on `-m` and `-fa`; the rest are optional and
forward-compatible (unknown args are ignored with a stderr note).

**stdin** — repeated length-prefixed chunks of 16 kHz mono audio:

```
[u32 LE sample_count][sample_count × f32 LE]   ← one chunk
...
[u32 LE 0]                                     ← finalize / flush marker
```

A `sample_count` of `0` is the finalize marker; **EOF also finalizes**.

**stdout** — one JSON object per line, flushed per line:

```json
{"type":"partial","text":"and so my fellow"}
{"type":"partial","text":"and so my fellow americans ask not"}
{"type":"final","text":"And so my fellow Americans ask not what your country can do for you..."}
```

`partial` events are revisable hypotheses emitted during streaming; **exactly
one** `final` event is emitted at the end (even for empty/zero-length audio, and
even if the model fails to load — so the manager's stdout reader never hangs).
JSON strings are escaped per RFC 8259. **stderr** is diagnostics only and is
never parsed.

### Streaming model (how partials are produced)

A rolling window plus a frozen committed prefix (clean-room, inspired by
whisper.cpp's sliding-window `stream` approach but written from scratch):

- Incoming samples accumulate in an active window.
- Every `--step-ms` of new audio, the active window is re-decoded and a
  `partial` = `committed_prefix + window_text` is emitted.
- When the window reaches `--window-ms`, its text is **committed** (frozen into
  the prefix) and the window is cleared. Committing on a clean boundary keeps
  partials strictly monotonic and avoids duplicated words across the seam.
- On finalize, the remaining window is decoded once and the single `final` =
  `committed_prefix + window_text` is emitted.

---

## Build contract (used by CI and local verification) — EXACT commands

whisper.cpp is built **once per platform/variant** by the release workflow
(pinned to `WHISPER_CPP_VERSION`, currently **`v1.8.4`**), exactly as it already
builds `whisper-cli`. This target then links against that prebuilt tree; it does
**not** fetch or build whisper.cpp itself.

Two cache variables point the build at the prebuilt whisper.cpp:

- `WHISPER_ROOT` — whisper.cpp **source** dir (has `include/whisper.h` and
  `ggml/include/`). **Required** unless whisper.cpp is installed so
  `find_package(whisper)` succeeds.
- `WHISPER_BUILD` — whisper.cpp **build** dir that contains the whisper library
  (`libwhisper.{dylib,so}` / `whisper.lib`). Defaults to `${WHISPER_ROOT}/build`.

### 1. Build whisper.cpp (same as the existing whisper-cli step)

macOS (Metal):

```bash
git clone --depth 1 --branch v1.8.4 https://github.com/ggml-org/whisper.cpp.git whisper.cpp
cmake -S whisper.cpp -B whisper.cpp/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DBUILD_SHARED_LIBS=ON \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=OFF
cmake --build whisper.cpp/build --config Release -j$(sysctl -n hw.ncpu)
```

Linux/Windows use the same clone with the variant flags the release workflow
already uses for that variant (`-DGGML_VULKAN=ON`, CUDA toolkit, or CPU). The
streaming sidecar needs a **from-source** whisper.cpp build so the whisper
headers and link library are present. On Windows this means the CUDA/CPU
variants must build whisper.cpp from source (as the Vulkan variant already
does) rather than only fetching the prebuilt binary zip.

> CMake ≥ 4 requires `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` when configuring
> whisper.cpp v1.8.4 (its top-level `cmake_minimum_required` predates CMake 4).
> This applies only to configuring whisper.cpp, not to this target.

### 2. Build `whisper-stream` against it

```bash
cmake -S sidecars/whisper-stream -B sidecars/whisper-stream/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_ROOT="$PWD/whisper.cpp"
cmake --build sidecars/whisper-stream/build --config Release -j
```

Output binary (stable path CI copies from):

```
sidecars/whisper-stream/build/whisper-stream        # whisper-stream.exe on Windows
```

`WHISPER_BUILD` may be passed explicitly if the build tree is not
`${WHISPER_ROOT}/build`, e.g. `-DWHISPER_BUILD=/path/to/whisper/out`.

### 3. Stage next to whisper-cli

Copy `whisper-stream` into each `whisper-runtimes/<variant>/` dir alongside
`whisper-cli` and the whisper/ggml shared libraries (the binary's runtime
search path is `@loader_path` / `$ORIGIN`, so it finds the sibling dylibs the
same way `whisper-cli` does). Once the binary is present,
`is_streaming_sidecar_available` flips to `true` and the app uses the streaming
path; until then it falls back to the chunked live-partial path.

---

## Local verification (what was actually run on macOS, arm64)

Performed with CMake 4.3.4, Apple clang 21, whisper.cpp `v1.8.4` (Metal):

1. Built `libwhisper` (Metal) from the `v1.8.4` clone with the step-1 command
   above (plus `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` for CMake 4).
2. Built `whisper-stream` with the step-2 command → `build/whisper-stream`.
3. Downloaded `ggml-tiny.en.bin` and streamed whisper.cpp's `samples/jfk.wav`
   (16 kHz mono) as ~0.5 s framed chunks followed by the `0` finalize marker.

Result: **11 progressive `partial` lines and exactly one `final`**, all
well-formed JSON, final text:
`"And so my fellow Americans ask not what your country can do for you ask what
you can do for your country."`

Edge cases verified:

- **Empty finalize** (immediate `0` marker) → single `{"type":"final","text":""}`.
- **EOF without a finalize marker** → still emits one `final` (no hang).
- **Missing/unloadable model** → emits `{"type":"final","text":""}` and exits
  non-zero, so the manager's reader never blocks waiting for a final.
