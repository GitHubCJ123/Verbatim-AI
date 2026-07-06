import { describe, expect, it } from "vitest";
import { providerTestStatus, troubleshootFor } from "./healthStatus";

describe("providerTestStatus", () => {
  it("keeps successful test results persistent and readable", () => {
    expect(
      providerTestStatus("cleanup", {
        ok: true,
        message: "Ollama ready",
        latencyMs: 42,
      }),
    ).toEqual({
      ok: true,
      title: "Cleanup test passed",
      message: "Ollama ready (42 ms)",
      latencyMs: 42,
    });
  });

  it("adds Supabase troubleshooting for cloud configuration failures", () => {
    const status = providerTestStatus("transcription", {
      ok: false,
      message: "Cloud AI needs Supabase configured",
    });

    expect(status.ok).toBe(false);
    expect(status.title).toBe("Transcription test failed");
    expect(status.troubleshoot).toContain("Switch this stage to a local engine");
  });

  it("adds Ollama troubleshooting for unreachable local cleanup", () => {
    expect(troubleshootFor("cleanup", "Couldn't reach Ollama at http://localhost:11434")).toContain(
      "Start Ollama",
    );
  });

  it("adds runtime troubleshooting for llama.cpp failures", () => {
    expect(troubleshootFor("cleanup", "llama.cpp runtime is not installed")).toContain(
      "Install the llama.cpp runtime",
    );
  });
});
