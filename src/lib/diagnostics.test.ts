// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as null | ((event: { payload: { enabled: boolean; generation: number } }) => void),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    _name: string,
    callback: (event: { payload: { enabled: boolean; generation: number } }) => void,
  ) => {
    h.listener = callback;
    return h.unlisten;
  },
}));

const report = (enabled: boolean, generation: number) => ({
  enabled,
  generation,
  appVersion: "0.5.17",
  platform: "synthetic",
  architecture: "synthetic",
  events: [],
});

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("local diagnostics consent and payloads", () => {
  beforeEach(() => {
    vi.resetModules();
    h.invoke.mockReset();
    h.listener = null;
    h.unlisten.mockReset();
  });

  it("does not submit events or stages before consent or after opt-out", async () => {
    const diagnostics = await import("./diagnostics");
    diagnostics.recordDiagnostic("transcription_failed");
    diagnostics.beginDiagnosticTrace().setStage("transcription");
    await flush();
    expect(h.invoke).not.toHaveBeenCalled();

    h.invoke.mockImplementation(async (command: string) => {
      if (command === "get_diagnostics") return report(true, 4);
      if (command === "set_diagnostics_enabled") return report(false, 5);
      return undefined;
    });
    await diagnostics.getDiagnostics();
    diagnostics.recordDiagnostic("polish_failed");
    expect(h.invoke).toHaveBeenCalledWith("record_diagnostic_event", {
      kind: "polish_failed",
      generation: 4,
    });

    await diagnostics.setDiagnosticsEnabled(false);
    h.invoke.mockClear();
    diagnostics.recordDiagnostic("transcription_failed");
    diagnostics.beginDiagnosticTrace().finish();
    await flush();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("ignores a stale policy response and never forwards exception content", async () => {
    let resolvePolicy!: (value: { enabled: boolean; generation: number }) => void;
    h.invoke.mockImplementation((command: string) =>
      command === "get_diagnostics_policy"
        ? new Promise((resolve) => {
            resolvePolicy = resolve;
          })
        : Promise.resolve(),
    );
    const diagnostics = await import("./diagnostics");
    const cleanup = diagnostics.installUiDiagnostics("overlay");
    await flush();
    h.listener!({ payload: { enabled: true, generation: 3 } });
    resolvePolicy({ enabled: false, generation: 2 });
    await flush();
    window.dispatchEvent(new ErrorEvent("error", { message: "Synthetic private transcript" }));
    const rejected = new Event("unhandledrejection");
    Object.defineProperty(rejected, "reason", { value: "Synthetic private clipboard" });
    window.dispatchEvent(rejected);
    expect(h.invoke).toHaveBeenCalledWith("record_diagnostic_event", {
      kind: "overlay_window_error",
      generation: 3,
    });
    expect(h.invoke).toHaveBeenCalledWith("record_diagnostic_event", {
      kind: "overlay_unhandled_rejection",
      generation: 3,
    });
    expect(JSON.stringify(h.invoke.mock.calls)).not.toContain("Synthetic private");

    h.listener!({ payload: { enabled: false, generation: 4 } });
    h.invoke.mockClear();
    window.dispatchEvent(new ErrorEvent("error", { message: "Another synthetic message" }));
    expect(h.invoke).not.toHaveBeenCalled();
    cleanup();
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("serializes trace stages with the generation active at recording start", async () => {
    let start!: (value: { generation: number; traceId: number }) => void;
    h.invoke.mockImplementation((command: string) => {
      if (command === "get_diagnostics") return Promise.resolve(report(true, 7));
      if (command === "begin_diagnostic_trace") {
        return new Promise((resolve) => {
          start = resolve;
        });
      }
      return Promise.resolve();
    });
    const diagnostics = await import("./diagnostics");
    await diagnostics.getDiagnostics();
    const trace = diagnostics.beginDiagnosticTrace();
    trace.setStage("transcription");
    trace.setStage("delivery");
    trace.finish();
    expect(h.invoke).toHaveBeenCalledWith("begin_diagnostic_trace", { generation: 7 });
    start({ generation: 7, traceId: 9 });
    await flush();
    expect(h.invoke.mock.calls.filter(([command]) => command === "set_diagnostic_stage")).toEqual([
      ["set_diagnostic_stage", { trace: { generation: 7, traceId: 9 }, stage: "transcription" }],
      ["set_diagnostic_stage", { trace: { generation: 7, traceId: 9 }, stage: "delivery" }],
      ["set_diagnostic_stage", { trace: { generation: 7, traceId: 9 }, stage: null }],
    ]);
  });

  it("formats only the report's explicit shareable fields", async () => {
    const diagnostics = await import("./diagnostics");
    const formatted = diagnostics.formatDiagnostics(report(true, 8));
    expect(JSON.parse(formatted)).toEqual({
      enabled: true,
      appVersion: "0.5.17",
      platform: "synthetic",
      architecture: "synthetic",
      events: [],
    });
    expect(formatted).not.toContain("generation");
  });

  it("does not return an older report after a newer opt-out", async () => {
    let resolveReport!: (value: ReturnType<typeof report>) => void;
    h.invoke.mockImplementation((command: string) => {
      if (command === "get_diagnostics") {
        return new Promise((resolve) => {
          resolveReport = resolve;
        });
      }
      if (command === "set_diagnostics_enabled") return Promise.resolve(report(false, 10));
      return Promise.resolve();
    });
    const diagnostics = await import("./diagnostics");
    const oldReport = diagnostics.getDiagnostics();
    await diagnostics.setDiagnosticsEnabled(false);
    resolveReport(report(true, 9));
    await expect(oldReport).rejects.toThrow("Diagnostics changed");
  });
});
