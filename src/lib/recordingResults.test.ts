import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingDeliveryResult, ReviewedDelivery } from "./recordingDelivery";

const h = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => Promise<void>>(),
  emit: vi.fn(async () => {}),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  recordDiagnostic: vi.fn(),
  disabled: false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: h.emit,
  listen: async (name: string, callback: (event: { payload: unknown }) => Promise<void>) => {
    h.listeners.set(name, callback);
    return () => h.listeners.delete(name);
  },
}));
vi.mock("../components/ui/Toast", () => ({ toast: h.toast }));
vi.mock("./diagnostics", () => ({ recordDiagnostic: h.recordDiagnostic }));
vi.mock("./appMode", () => ({ isLocalMode: () => true }));
vi.mock("./supabase", () => ({ supabase: {} }));
vi.mock("./store/useAuth", () => ({ useAuth: { getState: () => ({ user: null }) } }));
vi.mock("./preferences", () => ({
  isHistoryDisabled: () => h.disabled,
  getHistoryRetentionDays: () => null,
}));
import { installRecordingResultListeners } from "./recordingResults";
import { listTranscriptions } from "./history";

const result: RecordingDeliveryResult = {
  emitId: "synthetic-result",
  raw: "Synthetic raw.",
  cleaned: "Synthetic cleaned.",
  durationMs: 1000,
  language: "en",
  modeId: "synthetic-mode",
  modeName: "Synthetic",
  outputStyle: "paste",
  outputAction: "copied",
  saveHistory: true,
};
function send(name: string, payload: RecordingDeliveryResult | ReviewedDelivery) {
  return h.listeners.get(name)!({ payload });
}

describe("main recording listeners with real local history", () => {
  let storage: Map<string, string>;
  let quotaExceeded: boolean;
  beforeEach(async () => {
    storage = new Map();
    quotaExceeded = false;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (quotaExceeded) throw new Error("Synthetic quota exceeded");
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    });
    h.listeners.clear();
    h.disabled = false;
    vi.clearAllMocks();
    await installRecordingResultListeners();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists an explicit Copied action and reports Copied, not Pasted", async () => {
    await send("recording:result", result);
    expect((await listTranscriptions())[0].output_action).toBe("copied");
    expect(h.toast.success).toHaveBeenCalledWith("Copied");
    expect(h.emit).toHaveBeenCalledWith("recording:delivery-ack", {
      emitId: result.emitId,
      status: "saved",
    });
  });

  it("deduplicates concurrent event deliveries at the storage seam", async () => {
    await Promise.all([send("recording:result", result), send("recording:result", result)]);
    expect(await listTranscriptions()).toHaveLength(1);
  });

  it("does not assume a missing delivery action means pasted", async () => {
    await send("recording:result", { ...result, outputAction: undefined });
    expect(await listTranscriptions()).toEqual([]);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenLastCalledWith("recording:delivery-ack", {
      emitId: result.emitId,
      status: "failed",
    });
  });

  it("surfaces storage failure and permits a retry without silent loss", async () => {
    quotaExceeded = true;
    await send("recording:result", result);
    expect(h.recordDiagnostic).toHaveBeenCalledExactlyOnceWith("history_write_failed");
    expect(h.toast.error).toHaveBeenCalledWith("History wasn't saved", expect.any(Object));
    expect(h.emit).toHaveBeenLastCalledWith("recording:delivery-ack", {
      emitId: result.emitId,
      status: "failed",
    });
    quotaExceeded = false;
    await send("recording:result", result);
    await send("recording:result", result);
    expect(await listTranscriptions()).toHaveLength(1);
  });

  it.each(["global", "mode"])("keeps history-off (%s) results out of storage", async (scope) => {
    h.disabled = scope === "global";
    const original = { ...result, saveHistory: scope !== "mode", outputStyle: "review" as const };
    await send("recording:result", original);
    expect(storage.size).toBe(0);
    expect(h.recordDiagnostic).not.toHaveBeenCalled();
    await send("recording:reviewed", {
      emitId: "synthetic-reviewed",
      action: "copied",
      cleaned: "Synthetic edit.",
      modeId: original.modeId,
      result: original,
    });
    expect(storage.size).toBe(0);
    expect(h.emit).toHaveBeenLastCalledWith("recording:delivery-ack", {
      emitId: "synthetic-reviewed",
      status: "skipped",
    });
  });

  it("holds deliberate Review in memory and attaches only its own final edit", async () => {
    const original = { ...result, outputStyle: "review" as const };
    await send("recording:result", original);
    expect(await listTranscriptions()).toEqual([]);
    expect(h.toast.info).toHaveBeenCalledWith("Ready for Review");
    await send("recording:result", { ...original, emitId: "new-result", raw: "New raw." });
    await send("recording:reviewed", {
      emitId: "synthetic-reviewed",
      action: "pasted",
      cleaned: "Synthetic edit.",
      modeId: original.modeId,
      result: original,
    });
    const rows = await listTranscriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      raw_text: "Synthetic raw.",
      cleaned_text: "Synthetic edit.",
      output_action: "pasted",
    });
  });
});
