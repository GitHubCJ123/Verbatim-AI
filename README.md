# Verbatim AI

A Windows desktop voice-transcription app with a modern, animated UI.

> Talk anywhere. We type it for you, in your voice, in the right tone, in any app.

Hold a global hotkey, speak, release — Verbatim AI transcribes your audio, polishes it with the tone of the app you're in, and pastes the result wherever your cursor is.

See [`plan.md`](./plan.md) for the full product, architecture, and roadmap.

## Features

- **Global push-to-talk hotkey** — default `Ctrl+Space`, fully rebindable.
- **Per-app tone** — Slack stays casual, Gmail stays formal, code comments stay terse. Driven by user-defined Modes + app mappings.
- **Custom vocabulary** — keep proper nouns and jargon spelled correctly.
- **Translation** — speak any language, output in another.
- **Cloud-backed** — Supabase Postgres for sync, Supabase Edge Functions proxying Azure AI Foundry for transcription + polish. No keys on the client.
- **Local cleanup option** — run the polish step fully on-device via [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`), configurable globally or per Mode.
- **Tray-resident** — close the window, app keeps running. Autostart optional.
- **Dark + light themes**, follows OS by default.
- **Onboarding** generates Modes + app mappings from a few tone picks.

## Install

Grab the latest installer from [Releases](../../releases) and run either:

- `Verbatim AI_x.y.z_x64-setup.exe` (NSIS — recommended, per-user, no admin)
- `Verbatim AI_x.y.z_x64_en-US.msi` (MSI — for managed deployment)

> Windows SmartScreen will warn on first launch because the binaries are not yet code-signed. Click **More info → Run anyway**.

## Prerequisites (developers)

- **Node.js 20+** and **pnpm 9+**
- **Rust** stable — install via [rustup](https://rustup.rs)
- **MSVC Build Tools** — "Desktop development with C++" workload from [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **WebView2 Runtime** (ships with modern Windows)

## Dev

```powershell
pnpm install
Copy-Item .env.example .env.local   # fill in Supabase URL + anon key
pnpm tauri dev
```

The first `cargo` build takes several minutes; subsequent builds are incremental.

### Environment

Verbatim AI is online-only. Set these in `.env.local`:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY
```

Azure credentials live in **Supabase secrets**, not on the client. See [`supabase/functions/README.md`](./supabase/functions/README.md).

### Database

Apply migrations against your Supabase project:

```powershell
supabase db push
```

### Edge Functions

```powershell
supabase functions deploy transcribe --no-verify-jwt
supabase functions deploy cleanup --no-verify-jwt
```

## Local cleanup (Ollama or llama.cpp)

The **cleanup** step (tone polish / grammar fix) can run fully on-device instead of in the cloud. Pick a backend in **Settings → AI model → Cleanup provider**; it is independent from transcription and can be overridden per Mode. Cloud stays the default — nothing breaks if you never touch this.

Both local backends speak the same OpenAI-compatible `/v1/chat/completions` streaming API, so Verbatim AI reuses a single client for them.

### Ollama (easiest)

Install [Ollama](https://ollama.com), then pull a model in a terminal:

```powershell
ollama pull qwen3.5:4b
```

Select **Local (Ollama)** in Settings and pick the pulled model.

### llama.cpp (`llama-server`, max control)

[`llama.cpp`](https://github.com/ggml-org/llama.cpp) tracks upstream performance closely and runs **plain GGUF files you manage yourself** — no vendor-managed blobs. Build or download `llama-server` for your hardware:

| Backend | Build flag | Notes |
| --- | --- | --- |
| CUDA (NVIDIA) | `-DGGML_CUDA=ON` | Fastest on NVIDIA GPUs |
| Metal (Apple Silicon) | enabled by default on macOS | Use a Metal-enabled build |
| Vulkan (AMD / Intel / cross-vendor) | `-DGGML_VULKAN=ON` | Good AMD option on Windows/Linux |
| CPU | (default) | Works everywhere, slowest |

Download a GGUF model (e.g. from Hugging Face) and start the server:

```powershell
# Serve one GGUF over the OpenAI-compatible API on :8080
llama-server -m .\models\qwen2.5-7b-instruct-q4_k_m.gguf -c 4096 --port 8080

# Offload layers to the GPU (CUDA / Vulkan / Metal builds)
llama-server -m .\model.gguf --port 8080 -ngl 999

# Optionally require a key
llama-server -m .\model.gguf --port 8080 --api-key my-secret
```

In **Settings → AI model**, choose **Local (llama.cpp)** and set:

- **Base URL** — default `http://127.0.0.1:8080` (change the port if you run it elsewhere). Plain `http://` is allowed only for `localhost` / `127.0.0.1`; to reach a llama-server on another machine, expose it over `https://` or forward it to a local port (e.g. an SSH tunnel).
- **Model** — optional; leave blank to use whichever GGUF the server has loaded
- **API key** — optional; only if you launched with `--api-key`

Click **Test connection** to verify (it pings `/v1/models`). Keep important models as plain `.gguf` files so they stay portable across backends.

## Build a release installer

```powershell
pnpm tauri build
```

Outputs to `src-tauri/target/release/bundle/`:

- `nsis/Verbatim AI_x.y.z_x64-setup.exe`
- `msi/Verbatim AI_x.y.z_x64_en-US.msi`

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Vite dev server (frontend only) |
| `pnpm tauri dev` | Run desktop app in dev mode |
| `pnpm tauri build` | Build production installers (MSI + NSIS) |
| `pnpm lint` | Run ESLint |
| `pnpm format` | Run Prettier |

## License

TBD.
