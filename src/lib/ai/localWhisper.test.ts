import { describe, expect, it } from "vitest";
import {
  isCustomModelId,
  whisperComputePreferenceLabel,
  whisperRuntimeVariantLabel,
  WHISPER_TIERS,
  WHISPER_TIER_IDS,
  type WhisperComputePreference,
  type WhisperRuntimeVariant,
} from "./localWhisper";

describe("Whisper compute labels", () => {
  it("labels user-facing compute preferences", () => {
    const labels = (["auto", "cuda", "vulkan", "cpu"] as WhisperComputePreference[]).map(
      whisperComputePreferenceLabel,
    );

    expect(labels).toEqual(["Auto (recommended)", "NVIDIA (CUDA)", "GPU (Vulkan)", "CPU"]);
  });

  it("labels active runtime variants", () => {
    const labels = (["cuda", "vulkan", "metal", "cpu"] as WhisperRuntimeVariant[]).map(
      whisperRuntimeVariantLabel,
    );

    expect(labels).toEqual(["NVIDIA CUDA", "Vulkan GPU", "Apple Metal", "CPU"]);
  });
});

describe("Whisper model catalogue", () => {
  it("exposes the quantized large variant alongside the existing tiers", () => {
    expect(WHISPER_TIER_IDS).toContain("large-v3-q5_0");
    // The five original tiers keep working (no regression).
    for (const id of ["tiny", "base", "small", "turbo", "large-v3"] as const) {
      expect(WHISPER_TIER_IDS).toContain(id);
    }
  });

  it("keeps tier ids in sync with the catalogue metadata", () => {
    expect(WHISPER_TIER_IDS).toEqual(WHISPER_TIERS.map((t) => t.tier));
  });

  it("gives the quantized large variant a sub-full-weights footprint", () => {
    const q5 = WHISPER_TIERS.find((t) => t.tier === "large-v3-q5_0");
    const full = WHISPER_TIERS.find((t) => t.tier === "large-v3");
    expect(q5).toBeDefined();
    expect(full).toBeDefined();
    expect(q5!.approxSizeMB).toBeLessThan(full!.approxSizeMB);
  });

  it("recognises custom (bring-your-own) model ids", () => {
    expect(isCustomModelId("custom:my-model.gguf")).toBe(true);
    expect(isCustomModelId("custom:ggml-foo.bin")).toBe(true);
    expect(isCustomModelId("turbo")).toBe(false);
    expect(isCustomModelId("large-v3-q5_0")).toBe(false);
  });
});
