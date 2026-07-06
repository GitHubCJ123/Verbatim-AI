import { describe, expect, it } from "vitest";
import {
  whisperComputePreferenceLabel,
  whisperRuntimeVariantLabel,
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
