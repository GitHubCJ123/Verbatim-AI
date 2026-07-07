import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAllowedCommand,
  assertAllowedSandboxCommand,
  credentialFreeEnv,
} from "../lib/verifier.mjs";

describe("verifier safety", () => {
  it("scrubs credential-bearing environment variables", async () => {
    process.env.GH_TOKEN = "ghp_should_not_be_inherited";
    process.env.OPENAI_API_KEY = "sk-should-not-be-inherited";
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "issue-loop-verifier-"));

    const env = await credentialFreeEnv(cwd);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HOME).toContain(cwd);
    expect(env.GH_CONFIG_DIR).toContain(cwd);
  });

  it("denies dangerous configured commands", () => {
    expect(() => assertAllowedCommand("gh pr merge 1")).toThrow(/Denied/);
    expect(() => assertAllowedCommand("curl https://example.com")).toThrow(/Denied/);
  });

  it("restricts sandbox launchers to known sandbox tools", () => {
    expect(() => assertAllowedSandboxCommand("docker run --rm image")).not.toThrow();
    expect(() => assertAllowedSandboxCommand("bash -lc 'pnpm test'")).toThrow(/sandboxCommand/);
  });
});
