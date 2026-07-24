import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCustomModelId,
  whisperComputePreferenceLabel,
  whisperRuntimeVariantLabel,
  isLocalWhisperTranscribeActive,
  WHISPER_TIERS,
  WHISPER_TIER_IDS,
  type WhisperComputePreference,
  type WhisperRuntimeVariant,
} from "./localWhisper";
import type { Mode } from "../../types/mode";

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

describe("isLocalWhisperTranscribeActive (issue #33 streaming gate)", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function modeWithOverride(kind: Mode["transcribeProviderOverride"]): Mode {
    // Only the override field under test matters to this helper.
    return { transcribeProviderOverride: kind } as Mode;
  }

  it("is true by default (no stored kind, no mode) — Local Whisper is the fallback engine", () => {
    expect(isLocalWhisperTranscribeActive()).toBe(true);
  });

  it("is false when the global provider kind is Parakeet", () => {
    localStorage.setItem("sw.ai.provider", "local-parakeet");
    expect(isLocalWhisperTranscribeActive()).toBe(false);
  });

  it("is true when the global provider kind is explicitly Local Whisper", () => {
    localStorage.setItem("sw.ai.provider", "local-whisper");
    expect(isLocalWhisperTranscribeActive()).toBe(true);
  });

  it("a Mode override to Parakeet wins over a global Local Whisper setting", () => {
    localStorage.setItem("sw.ai.provider", "local-whisper");
    expect(isLocalWhisperTranscribeActive(modeWithOverride("local-parakeet"))).toBe(false);
  });

  it("a Mode override to Local Whisper wins over a global Parakeet setting", () => {
    localStorage.setItem("sw.ai.provider", "local-parakeet");
    expect(isLocalWhisperTranscribeActive(modeWithOverride("local-whisper"))).toBe(true);
  });

  it("a null Mode override falls back to the global setting", () => {
    localStorage.setItem("sw.ai.provider", "local-parakeet");
    expect(isLocalWhisperTranscribeActive(modeWithOverride(null))).toBe(false);
  });

  it("coerces a stale 'cloud' kind to local-whisper while cloud features are disabled", () => {
    // CLOUD_FEATURES_ENABLED is false in this build; a previously persisted
    // "cloud" selection must not make the streaming gate think Cloud is
    // active (it resolves to the local engine, same as the rest of the app).
    localStorage.setItem("sw.ai.provider", "cloud");
    expect(isLocalWhisperTranscribeActive()).toBe(true);
  });
});
