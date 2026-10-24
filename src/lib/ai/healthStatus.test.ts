import { describe, expect, it } from "vitest";
import { providerTestStatus, troubleshootFor } from "./healthStatus";

describe("providerTestStatus", () => {
  it("keeps successful test results persistent and readable", () => {
    expect(
      providerTestStatus("cleanup", {
        ok: true,
        message: "Qwen3.5 2B ready",
        latencyMs: 42,
      }),
    ).toEqual({
      ok: true,
      title: "Cleanup test passed",
      message: "Qwen3.5 2B ready (42 ms)",
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

  it("points to the model list when the cleanup model is missing", () => {
    expect(troubleshootFor("cleanup", "Qwen3.5 2B isn't downloaded yet.")).toContain(
      "Download the selected model",
    );
  });

  it("suggests re-downloading when the cleanup engine can't start", () => {
    expect(troubleshootFor("cleanup", "The AI polish engine exited during startup")).toContain(
      "download it again",
    );
  });
});
