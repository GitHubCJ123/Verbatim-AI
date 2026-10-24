import type { ProviderHealth } from "./AIProvider";

export type ProviderStage = "transcription" | "cleanup";

export interface ProviderTestStatus {
  ok: boolean;
  title: string;
  message: string;
  troubleshoot?: string;
  latencyMs?: number;
}

export function providerTestStatus(
  stage: ProviderStage,
  health: ProviderHealth,
): ProviderTestStatus {
  const label = stage === "transcription" ? "Transcription" : "Cleanup";
  if (health.ok) {
    return {
      ok: true,
      title: `${label} test passed`,
      message: health.latencyMs ? `${health.message} (${health.latencyMs} ms)` : health.message,
      latencyMs: health.latencyMs,
    };
  }
  return {
    ok: false,
    title: `${label} test failed`,
    message: health.message,
    troubleshoot: troubleshootFor(stage, health.message),
    latencyMs: health.latencyMs,
  };
}

export function troubleshootFor(stage: ProviderStage, message: string): string {
  const m = message.toLowerCase();
  if (m.includes("supabase") || m.includes("vite_supabase") || m.includes("not signed in")) {
    return "Cloud AI needs Supabase configuration and, in cloud app mode, a signed-in account. Switch this stage to a local engine or configure Supabase.";
  }
  if (stage === "cleanup" && m.includes("isn't downloaded")) {
    return "Download the selected model from the list above, then run the test again.";
  }
  if (stage === "cleanup" && (m.includes("polish engine") || m.includes("checksum"))) {
    return "Delete the model and download it again. If it still fails, pick a smaller model.";
  }
  if (m.includes("runtime") || m.includes("not installed")) {
    return `Install the ${stage === "transcription" ? "transcription" : "cleanup"} runtime, then run the test again.`;
  }
  if (m.includes("model") && (m.includes("not downloaded") || m.includes("no model"))) {
    return "Download or select a model for this engine, then run the test again.";
  }
  return "Check the selected engine, runtime, model, and network settings, then run the test again.";
}
