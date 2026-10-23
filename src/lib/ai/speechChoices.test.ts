import { describe, expect, it } from "vitest";
import {
  SPEECH_CHOICES,
  currentSpeechChoice,
  isSpeechChoiceInstalled,
  speechChoiceById,
} from "./speechChoices";

describe("speech choices", () => {
  it("offers exactly three curated choices with Parakeet v3 recommended", () => {
    expect(SPEECH_CHOICES.map((c) => c.id)).toEqual([
      "parakeet-v3",
      "whisper-turbo",
      "whisper-base",
    ]);
    expect(SPEECH_CHOICES.filter((c) => c.recommended).map((c) => c.id)).toEqual(["parakeet-v3"]);
  });

  it("maps current settings to a choice, or null for advanced setups", () => {
    expect(currentSpeechChoice("local-parakeet", "turbo", "v3")).toBe("parakeet-v3");
    expect(currentSpeechChoice("local-whisper", "turbo", "v3")).toBe("whisper-turbo");
    expect(currentSpeechChoice("local-whisper", "base", "v3")).toBe("whisper-base");
    expect(currentSpeechChoice("local-parakeet", "turbo", "v2")).toBeNull();
    expect(currentSpeechChoice("local-whisper", "large-v3", "v3")).toBeNull();
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
