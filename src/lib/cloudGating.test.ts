import { describe, expect, it } from "vitest";
import { CLOUD_FEATURES_ENABLED } from "./features";
import { effectiveTranscribeKind } from "./ai/localWhisper";
import { effectiveCleanupKind } from "./ai/localCleanup";

// These assertions are written for the shipped state of the flag
// (cloud disabled). If cloud is ever re-enabled, update expectations.
describe("cloud feature gating", () => {
  it("ships with cloud features disabled", () => {
    expect(CLOUD_FEATURES_ENABLED).toBe(false);
  });

  it("coerces a cloud transcription kind to a local engine", () => {
    // Covers both the global setting and a stale per-Mode override that
    // still holds "cloud" from before the flag was flipped.
    expect(effectiveTranscribeKind("cloud")).toBe("local-whisper");
  });

  it("leaves local transcription kinds untouched", () => {
    expect(effectiveTranscribeKind("local-whisper")).toBe("local-whisper");
    expect(effectiveTranscribeKind("local-parakeet")).toBe("local-parakeet");
  });

  it("coerces a cloud cleanup kind to the built-in engine", () => {
    expect(effectiveCleanupKind("cloud")).toBe("local");
  });

  it("resolves older local cleanup kinds to the built-in engine", () => {
    expect(effectiveCleanupKind("local")).toBe("local");
    expect(effectiveCleanupKind("local-ollama")).toBe("local");
    expect(effectiveCleanupKind("local-llama-cpp")).toBe("local");
  });
});
