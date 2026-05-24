# Verbatim AI

A Windows desktop voice-transcription app with a modern, animated UI.

> Talk anywhere. We type it for you, in your voice, in the right tone, in any app.

See [`plan.md`](./plan.md) for the full product, architecture, and roadmap spec.

## Status

**Phase 0 — Scaffold** ✅ — Tauri 2 + Vite + React 19 + TypeScript foundation with Tailwind, Framer Motion, Zustand, React Router, Lucide, React Hook Form, Zod, Sonner, ESLint, Prettier, rustfmt.

See `plan.md` §21 for the full phase roadmap.

## Prerequisites (Windows)

- **Node.js 20+** and **pnpm 9+**
- **Rust** (stable) — install via [rustup](https://rustup.rs)
- **MSVC Build Tools** — "Desktop development with C++" workload from [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **WebView2 Runtime** (ships with modern Windows)

## Dev

```powershell
pnpm install
pnpm tauri dev
```

The first `cargo` build will take several minutes. Subsequent builds are incremental.

## Build a release installer

```powershell
pnpm tauri build
```

Outputs `.msi` and NSIS `-setup.exe` to `src-tauri/target/release/bundle/`.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Vite dev server (frontend only) |
| `pnpm tauri dev` | Run desktop app in dev mode |
| `pnpm tauri build` | Build production installer |
| `pnpm lint` | Run ESLint |
| `pnpm format` | Run Prettier |

## License

TBD.
