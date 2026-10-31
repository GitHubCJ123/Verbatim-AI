import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { OutputAction } from "./history";

export interface RecordingDeliveryResult {
  emitId: string;
  raw: string;
  cleaned: string;
  durationMs: number;
  language: string;
  modeName: string;
  modeId: string | null;
  outputStyle: "paste" | "review";
  outputAction?: OutputAction;
  saveHistory: boolean;
}

export interface ReviewedDelivery {
  emitId: string;
  action: OutputAction;
  cleaned: string;
  modeId: string | null;
  result?: RecordingDeliveryResult;
}

export interface DeliveryAck {
  emitId: string;
  status: "saved" | "skipped" | "pending" | "failed";
}

export class RecordingDeliveryError extends Error {}

export function deliveryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Keep the overlay's text until the main window has handled the result. */
export async function relayDelivery(
  name: "recording:result" | "recording:reviewed",
  payload: RecordingDeliveryResult | ReviewedDelivery,
): Promise<void> {
  let resolveAck!: (value: DeliveryAck) => void;
  let rejectAck!: (error: Error) => void;
  const ack = new Promise<DeliveryAck>((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
  const off = await listen<DeliveryAck>("recording:delivery-ack", (event) => {
    if (event.payload.emitId === payload.emitId) resolveAck(event.payload);
  }).catch(() => {
    throw new RecordingDeliveryError(
      "Couldn't listen for delivery confirmation. Your text is still here; Copy it before closing.",
    );
  });
  const timer = setTimeout(
    () =>
      rejectAck(
        new RecordingDeliveryError(
          "The main window didn't confirm this result. Your text is still here; Copy or try again.",
        ),
      ),
    4000,
  );
  try {
    const [, result] = await Promise.all([invoke("relay_event", { name, payload }), ack]);
    if (result.status === "failed") {
      throw new RecordingDeliveryError(
        "History couldn't be saved. Your text is still here; Copy or try again.",
      );
    }
  } catch (error) {
    if (error instanceof RecordingDeliveryError) throw error;
    throw new RecordingDeliveryError(
      "The main window couldn't confirm this result. Your text is still here; Copy it before closing.",
    );
  } finally {
    clearTimeout(timer);
    off();
  }
}
