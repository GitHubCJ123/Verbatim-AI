import { defineConfig } from "vitest/config";

// Real-engine golden tests: these instantiate an actual provider and hit a
// real backend (a llama-server you started, a local/remote Supabase Edge
// Function, etc.). Every suite self-skips via `describe.skipIf(...)` when
// its engine isn't configured, so this config is safe to run anywhere.
// A skip is not coverage.
//
// NOTE: providers that reach their engine through Tauri `invoke` (local
// whisper-cli/server, parakeet, the built-in cleanup engine) cannot run here
// — there is no Rust backend in a Node test process. The cleanup pipeline
// test talks to llama-server over HTTP instead. Those are covered per-PR by
// IPC-mocked wrapper tests, and end-to-end by Rust integration / Tauri E2E
// tests (see docs/testing/automated-testing-strategy.md).
export default defineConfig({
  test: {
    include: ["src/**/*.engine.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
