/**
 * Data-locality status: does dictation content leave this machine?
 * (docs/improvement-plan/05-security-privacy.md, F3)
 *
 * Computed from the resolved provider pair — per-Mode overrides win
 * over global settings, mirroring getActiveProvider's resolution in
 * src/lib/ai/index.ts. Scope is dictation content only (audio + raw
 * text); app updates and optional account sync still use the network.
 */
import type { Mode } from "../types/mode";
import { getAiProviderKind, getCleanupProviderKind } from "./ai";
import { isAiImproveDisabled } from "./preferences";

export type DataLocality = "local" | "mixed" | "cloud";

export interface PrivacyStatus {
  /** Where the audio goes. */
  transcription: "cloud" | "local";
  /** Where the raw text goes. "off" = cleanup skipped entirely. */
  cleanup: "cloud" | "local" | "off";
  overall: DataLocality;
}

export function getPrivacyStatus(mode?: Mode | null): PrivacyStatus {
  const transcription =
    (mode?.transcribeProviderOverride ?? getAiProviderKind()) === "cloud"
      ? "cloud"
      : "local";

  let cleanup: PrivacyStatus["cleanup"];
  if (mode?.skipCleanup || isAiImproveDisabled()) {
    cleanup = "off";
  } else {
    cleanup =
      (mode?.cleanupProviderOverride ?? getCleanupProviderKind()) === "cloud"
        ? "cloud"
        : "local";
  }

  let overall: DataLocality;
  if (transcription === "local" && cleanup !== "cloud") overall = "local";
  else if (transcription === "cloud" && cleanup === "cloud") overall = "cloud";
  else overall = "mixed";

  return { transcription, cleanup, overall };
}
