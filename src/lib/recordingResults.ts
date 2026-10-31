import { emit, listen } from "@tauri-apps/api/event";
import { toast } from "../components/ui/Toast";
import { addTranscription, type OutputAction } from "./history";
import { isHistoryDisabled } from "./preferences";
import type { DeliveryAck, RecordingDeliveryResult, ReviewedDelivery } from "./recordingDelivery";

export async function installRecordingResultListeners(): Promise<() => void> {
  let pending: RecordingDeliveryResult | null = null;
  const handled = new Map<string, DeliveryAck["status"]>();
  const inFlight = new Map<string, Promise<void>>();
  const receive = (emitId: string, handle: () => Promise<void>) => {
    const existing = inFlight.get(emitId);
    if (existing) return existing;
    const work = handle().catch(() => {
      toast.error("Couldn't confirm dictation delivery", {
        description: "Keep your text in Review and use Copy before closing.",
      });
    });
    inFlight.set(emitId, work);
    void work.then(() => inFlight.delete(emitId));
    return work;
  };
  const acknowledge = async (emitId: string, status: DeliveryAck["status"]) => {
    if (status !== "failed") {
      handled.set(emitId, status);
      if (handled.size > 50) {
        const first = handled.keys().next().value;
        if (first) handled.delete(first);
      }
    }
    await emit("recording:delivery-ack", { emitId, status });
  };
  const persist = async (
    result: RecordingDeliveryResult,
    action: OutputAction,
    cleaned = result.cleaned,
  ): Promise<DeliveryAck["status"]> => {
    if (!result.saveHistory || isHistoryDisabled()) return "skipped";
    try {
      await addTranscription({
        modeId: result.modeId,
        modeNameSnap: result.modeName,
        rawText: result.raw,
        cleanedText: cleaned,
        audioDurationMs: Math.round(result.durationMs),
        outputAction: action,
        languageDetected: result.language,
      });
      return "saved";
    } catch {
      toast.error("History wasn't saved", {
        description: "Your text remains in Review. Copy it before closing, or try again.",
      });
      return "failed";
    }
  };
  const offResult = await listen<RecordingDeliveryResult>("recording:result", (event) =>
    receive(event.payload.emitId, async () => {
      const result = event.payload;
      const previous = handled.get(result.emitId);
      if (previous) {
        await acknowledge(result.emitId, previous);
        return;
      }
      pending = result;
      // Review is intentionally not yet a delivery, and is only held in memory.
      if (result.outputStyle === "review") {
        toast.info("Ready for Review");
        await acknowledge(result.emitId, "pending");
        return;
      }
      if (result.outputAction !== "pasted" && result.outputAction !== "copied") {
        toast.error("Delivery wasn't confirmed", { description: "Keep your text in Review." });
        await acknowledge(result.emitId, "failed");
        return;
      }
      const status = await persist(result, result.outputAction);
      toast.success(result.outputAction === "pasted" ? "Pasted" : "Copied");
      if (status !== "failed") pending = null;
      await acknowledge(result.emitId, status);
    }),
  );
  const offReviewed = await listen<ReviewedDelivery>("recording:reviewed", (event) =>
    receive(event.payload.emitId, async () => {
      const reviewed = event.payload;
      const previous = handled.get(reviewed.emitId);
      if (previous) {
        await acknowledge(reviewed.emitId, previous);
        return;
      }
      // Include the original result so a late callback cannot attach to a newer
      // recording, and review can recover after an earlier result relay failed.
      const result = reviewed.result ?? pending;
      if (!result || result.modeId !== reviewed.modeId) {
        await acknowledge(reviewed.emitId, "failed");
        return;
      }
      const status = await persist(result, reviewed.action, reviewed.cleaned);
      if (status !== "failed" || reviewed.action === "discarded") {
        if (pending?.emitId === result.emitId) pending = null;
        toast[reviewed.action === "discarded" ? "info" : "success"](
          reviewed.action === "pasted"
            ? "Pasted"
            : reviewed.action === "copied"
              ? "Copied"
              : "Discarded",
        );
      }
      await acknowledge(reviewed.emitId, status);
    }),
  );
  return () => {
    offResult();
    offReviewed();
    pending = null;
  };
}
