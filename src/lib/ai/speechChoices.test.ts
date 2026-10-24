import { describe, expect, it } from "vitest";
import {
  SPEECH_CHOICES,
  accuracyScore,
  speedScore,
  currentSpeechChoice,
  isSpeechChoiceInstalled,
  speechChoiceById,
} from "./speechChoices";

describe("speech choices", () => {
  it("lists every built-in model once, including Canary, with one recommendation", () => {
    const ids = SPEECH_CHOICES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("canary-180m-flash");
    expect(SPEECH_CHOICES.filter((c) => c.recommended)).toHaveLength(1);
  });

  it("derives 0-10 scores from the measured figures", () => {
    for (const c of SPEECH_CHOICES) {
      expect(c.quality).toBe(accuracyScore(c.werPct));
      expect(c.speed).toBe(speedScore(c.secondsPer10s));
      expect(c.quality).toBeGreaterThan(0);
      expect(c.speed).toBeGreaterThan(0);
      expect(c.werPct).toBeGreaterThan(0);
      expect(c.secondsPer10s).toBeGreaterThan(0);
    }
  });

  it("scores lower error and lower latency higher, clamped to 0-10", () => {
    expect(accuracyScore(0)).toBe(10);
    expect(accuracyScore(15)).toBe(0);
    expect(accuracyScore(40)).toBe(0);
    expect(accuracyScore(2.4)).toBeGreaterThan(accuracyScore(4.18));
    expect(speedScore(0)).toBe(10);
    expect(speedScore(4.5)).toBe(0);
    expect(speedScore(0.16)).toBeGreaterThan(speedScore(1.1));
  });

  it("keeps the benchmark ordering the UI promises", () => {
    const by = (id: string) => SPEECH_CHOICES.find((c) => c.id === id)!;
    expect(by("canary-180m-flash").speed).toBeGreaterThan(by("parakeet-v3").speed);
    expect(by("parakeet-v2").quality).toBeGreaterThan(by("parakeet-v3").quality);
    expect(by("whisper-tiny").quality).toBeLessThan(by("whisper-small").quality);
  });

  it("maps current settings to a model, or null for custom files and cloud", () => {
    expect(currentSpeechChoice("local-parakeet", "turbo", "v3")).toBe("parakeet-v3");
    expect(currentSpeechChoice("local-parakeet", "turbo", "v2")).toBe("parakeet-v2");
    expect(currentSpeechChoice("local-parakeet", "turbo", "canary-180m-flash")).toBe(
      "canary-180m-flash",
    );
    expect(currentSpeechChoice("local-whisper", "turbo", "v3")).toBe("whisper-turbo");
    expect(currentSpeechChoice("local-whisper", "large-v3", "v3")).toBe("whisper-large-v3");
    expect(currentSpeechChoice("local-whisper", "custom:x.bin", "v3")).toBeNull();
    expect(currentSpeechChoice("cloud", "turbo", "v3")).toBeNull();
  });

  it("requires both runtime and model to count as installed", () => {
    const parakeet = speechChoiceById("parakeet-v3");
    const base = speechChoiceById("whisper-base");
    const state = {
      whisperRuntime: true,
      whisperTiers: { base: true },
      parakeetRuntime: false,
      parakeetVariants: { v3: true },
    };
    expect(isSpeechChoiceInstalled(base, state)).toBe(true);
    expect(isSpeechChoiceInstalled(parakeet, state)).toBe(false);
    expect(isSpeechChoiceInstalled(parakeet, { ...state, parakeetRuntime: true })).toBe(true);
  });
});
