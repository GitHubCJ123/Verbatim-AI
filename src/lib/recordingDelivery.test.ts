import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryAck, RecordingDeliveryResult } from "./recordingDelivery";

const h = vi.hoisted(() => ({
  listener: null as null | ((event: { payload: DeliveryAck }) => void),
  invoke: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, callback: (event: { payload: DeliveryAck }) => void) => {
    h.listener = callback;
    return h.unlisten;
  },
}));
import { relayDelivery, RecordingDeliveryError } from "./recordingDelivery";

const result: RecordingDeliveryResult = {
  emitId: "synthetic-delivery",
  raw: "Synthetic.",
  cleaned: "Synthetic.",
  durationMs: 1000,
  modeId: null,
  modeName: "Synthetic",
  language: "en",
  outputStyle: "paste",
  outputAction: "pasted",
  saveHistory: false,
};
describe("recording delivery acknowledgement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.listener = null;
    h.unlisten.mockClear();
    h.invoke.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it.each(["saved", "skipped", "pending"] as const)(
    "waits for a matching %s ack",
    async (status) => {
      h.invoke.mockImplementation(async () => {
        h.listener!({ payload: { emitId: "other-result", status: "failed" } });
        h.listener!({ payload: { emitId: result.emitId, status } });
      });
      await expect(relayDelivery("recording:result", result)).resolves.toBeUndefined();
      expect(h.unlisten).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a failed-history ack and removes the listener", async () => {
    h.invoke.mockImplementation(async () => {
      h.listener!({ payload: { emitId: result.emitId, status: "failed" } });
    });
    await expect(relayDelivery("recording:result", result)).rejects.toThrow(
      "History couldn't be saved",
    );
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("times out a dropped event instead of clearing unconfirmed text", async () => {
    h.invoke.mockResolvedValue(undefined);
    const assertion = expect(relayDelivery("recording:result", result)).rejects.toThrow(
      "didn't confirm",
    );
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("classifies IPC rejection as delivery failure and cleans up", async () => {
    h.invoke.mockRejectedValue(new Error("Synthetic IPC failure"));
    await expect(relayDelivery("recording:result", result)).rejects.toBeInstanceOf(
      RecordingDeliveryError,
    );
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
