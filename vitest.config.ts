import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

// Default (fast) test run used by `pnpm test` and the PR gate: unit +
// IPC-mocked integration tests. The real-engine golden tests live in
// `*.engine.test.ts` and are excluded here — run them with
// `pnpm test:engines` (see vitest.engines.config.ts).
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [...configDefaults.exclude, "**/*.engine.test.ts"],
  },
});
