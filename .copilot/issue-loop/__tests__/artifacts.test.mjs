import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_PHASE_PREFIXES,
  appendRunlog,
  artifactDirectory,
  canonicalArtifactId,
  nextArtifactId,
  readIssueAutomationSummary,
  recordArtifact,
  runlogPath,
  summaryPath,
} from "../lib/artifacts.mjs";

const issue = { number: 18, title: "Install bug" };
const runtimeRoot = path.join(
  process.cwd(),
  ".copilot/issue-loop/__tests__/.artifacts-runtime",
);

describe("automation artifact helpers", () => {
  beforeEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  it("uses the issue artifact directory and registry prefixes", () => {
    expect(artifactDirectory(runtimeRoot, issue)).toBe(
      path.join(runtimeRoot, "docs/automation/specs/issue-0018-install-bug/artifacts"),
    );
    expect(summaryPath(runtimeRoot, issue)).toBe(
      path.join(artifactDirectory(runtimeRoot, issue), "summary.json"),
    );
    expect(runlogPath(runtimeRoot, issue)).toBe(
      path.join(artifactDirectory(runtimeRoot, issue), "runlog.jsonl"),
    );
    expect(ARTIFACT_PHASE_PREFIXES).toEqual({
      requirements: "PRD",
      spec: "SPEC",
      "adversarial-review": "ADV",
      implementation: "IMPL",
      "agent-pr-review": "REVIEW",
      verification: "VER",
      finalization: "FINAL",
      "human-pr-review": "HUMAN",
      "self-reflection": "REFLECT",
      cleanup: "CLEAN",
    });
  });

  it("allocates next display IDs from a resilient summary shape", () => {
    expect(nextArtifactId(undefined, "requirements")).toBe("PRD-001");
    expect(
      nextArtifactId(
        {
          artifacts: [
            { displayId: "PRD-001" },
            { displayId: "SPEC-001" },
            { displayId: "PRD-009" },
          ],
        },
        "requirements",
      ),
    ).toBe("PRD-010");
  });

  it("builds sanitized canonical artifact IDs", () => {
    expect(canonicalArtifactId(issue, "run/1 secret", "PRD-001")).toBe(
      "issue-0018-run-1-secret-PRD-001",
    );
    expect(canonicalArtifactId(issue, "ghp_1234567890abcdefghijklmnop", "PRD-001")).toBe(
      "issue-0018-REDACTED-PRD-001",
    );
  });

  it("returns an empty summary when summary.json is missing or corrupt", async () => {
    expect(await readIssueAutomationSummary(runtimeRoot, issue)).toMatchObject({
      artifacts: [],
      latestArtifacts: {},
      phaseStatuses: {},
    });

    await fs.mkdir(artifactDirectory(runtimeRoot, issue), { recursive: true });
    await fs.writeFile(summaryPath(runtimeRoot, issue), "{not json", "utf8");

    expect(await readIssueAutomationSummary(runtimeRoot, issue)).toMatchObject({
      artifacts: [],
      latestArtifacts: {},
      phaseStatuses: {},
    });
  });

  it("records redacted markdown, runlog entries, checksums, and summary state", async () => {
    const result = await recordArtifact({
      root: runtimeRoot,
      issue,
      phase: "requirements",
      agent: "requirements-agent",
      title: "Token ghp_1234567890abcdefghijklmnop",
      summary: "Use AZURE_API_KEY=supersecret",
      body: "Body with OPENAI_API_KEY=sk-abcdef012345678901234567890",
      runId: "run-1",
      metadata: {
        model: "test-model",
        prompt: "raw prompt must not persist",
        env: { GH_TOKEN: "ghp_1234567890abcdefghijklmnop" },
        nested: { note: "github_pat_1234567890abcdefghijklmnop" },
      },
    });

    const markdown = await fs.readFile(result.path, "utf8");
    const expectedSha = crypto.createHash("sha256").update(markdown).digest("hex");
    const summary = JSON.parse(await fs.readFile(summaryPath(runtimeRoot, issue), "utf8"));
    const runlog = await fs.readFile(runlogPath(runtimeRoot, issue), "utf8");

    expect(markdown).toContain("<!-- verbatim-ai:artifact:v1");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).not.toContain("supersecret");
    expect(result.sha256).toBe(expectedSha);
    expect(summary.artifacts).toHaveLength(1);
    expect(summary.latestArtifacts.requirements.sha256).toBe(expectedSha);
    expect(summary.phaseStatuses.requirements).toMatchObject({
      status: "complete",
      latestDisplayId: "PRD-001",
    });
    expect(summary.artifacts[0].metadata).toEqual({
      model: "test-model",
      nested: { note: "[REDACTED]" },
    });
    expect(runlog).toContain("artifact.recorded");
    expect(runlog).not.toContain("raw prompt");
    expect(runlog).not.toContain("GH_TOKEN");
  });

  it("appends sanitized runlog JSON lines", async () => {
    await appendRunlog(runtimeRoot, issue, {
      type: "agent.finished",
      stdout: "do not store raw output",
      commandOutput: "do not store raw command output",
      result: "do not store ambiguous result text",
      detail: "ANTHROPIC_API_KEY=secret-value",
    });

    const line = (await fs.readFile(runlogPath(runtimeRoot, issue), "utf8")).trim();
    const entry = JSON.parse(line);

    expect(entry.stdout).toBeUndefined();
    expect(entry.commandOutput).toBeUndefined();
    expect(entry.result).toBeUndefined();
    expect(entry.detail).toBe("[REDACTED]");
  });

  it("wraps non-object runlog events safely", async () => {
    await appendRunlog(runtimeRoot, issue, "OPENAI_API_KEY=sk-abcdef012345678901234567890");

    const line = (await fs.readFile(runlogPath(runtimeRoot, issue), "utf8")).trim();
    expect(JSON.parse(line).event).toBe("[REDACTED]");
  });
});
