import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recommendedSpeechChoice } from "./modelPresentation";
import { SPEECH_CHOICES, currentSpeechChoice } from "../../lib/ai/speechChoices";
import { CLEANUP_MODELS } from "../../lib/ai/localCleanup";
import { SpeechModelPicker } from "./SpeechModelPicker";
import { CleanupModelPicker } from "./CleanupModelPicker";

vi.mock("../../lib/hotkey", () => ({
  loadHotkeyConfig: () => ({ spec: "F9", pushToTalk: false }),
  usesHoldToTalk: () => false,
}));

function storage(values: Record<string, string> = {}) {
  const state = new Map(Object.entries(values));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => state.get(key) ?? null,
    setItem: (key: string, value: string) => state.set(key, value),
  });
  return state;
}

afterEach(() => vi.unstubAllGlobals());

describe("simplified model presentation", () => {
  it("recommends Parakeet only for its supported languages", () => {
    for (const language of ["en", "fr", "de", "uk"]) {
      expect(recommendedSpeechChoice(language).id).toBe("parakeet-v3");
    }
    for (const language of ["auto", "he", "ja", "ar", "unknown"]) {
      expect(recommendedSpeechChoice(language).id).toBe("whisper-turbo");
    }
  });

  it("keeps the entire speech catalog behind Advanced and leaves storage untouched", () => {
    const state = storage({
      "sw.ai.provider": "local-whisper",
      "sw.ai.localWhisperTier": "custom:synthetic.bin",
      "sw.ai.parakeetLanguage": "he",
    });
    const before = [...state];
    const html = renderToStaticMarkup(<SpeechModelPicker />);
    for (const choice of SPEECH_CHOICES) expect(html).toContain(choice.name);
    expect(html).toContain("Advanced · all speech models");
    expect(html).toContain("custom model file");
    expect(html).not.toContain("<details open");
    expect([...state]).toEqual(before);
  });

  it("keeps stored cloud selections intact while local fallback is displayed", () => {
    const state = storage({ "sw.ai.provider": "cloud", "sw.ai.cleanupProvider": "cloud" });
    renderToStaticMarkup(<SpeechModelPicker />);
    renderToStaticMarkup(<CleanupModelPicker />);
    expect(state.get("sw.ai.provider")).toBe("cloud");
    expect(state.get("sw.ai.cleanupProvider")).toBe("cloud");
    expect(currentSpeechChoice("local-whisper", "custom:synthetic.bin", "v3")).toBeNull();
  });

  it("preserves every polish option without downloading on render", () => {
    const state = storage();
    const html = renderToStaticMarkup(<CleanupModelPicker />);
    for (const model of CLEANUP_MODELS) expect(html).toContain(model.name);
    expect(html).toContain("Advanced · all polish models");
    expect(html).not.toContain("<details open");
    expect(state.size).toBe(0);
  });

  it("asks for a compatible Canary language instead of displaying a silent English fallback", () => {
    const state = storage({
      "sw.ai.provider": "local-parakeet",
      "sw.ai.parakeetVariant": "canary-180m-flash",
      "sw.ai.parakeetLanguage": "he",
    });
    const html = renderToStaticMarkup(<SpeechModelPicker />);
    expect(html).toContain("Canary spoken language");
    expect(html).toContain("Your saved language is unsupported");
    expect(html).toContain("Choose language");
    expect(state.get("sw.ai.parakeetLanguage")).toBe("he");
  });
});
