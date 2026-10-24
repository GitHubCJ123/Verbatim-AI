import { describe, expect, it } from "vitest";
import {
  guessLanguage,
  isLightCleanupMode,
  looksClean,
  prepareForCleanup,
  resolveCleanupLanguage,
} from "./cleanupPrepass";
import { DEFAULT_MODE_PROMPT } from "../store/builtinModes";

describe("prepareForCleanup", () => {
  it.each([
    ["um so the meeting is moved to three no four pm", "so the meeting is moved to four pm"],
    ["the flight leaves at seven no eight thirty", "the flight leaves at eight thirty"],
    [
      "Uh, I think we should we should ship it on on Friday.",
      "I think we should ship it on Friday.",
    ],
    ["eh entonces nos vemos el viernes", "entonces nos vemos el viernes"],
    ["euh je pense que on peut on peut finir demain", "je pense que on peut finir demain"],
    ["set it to 5, sorry, 6 minutes", "set it to 6 minutes"],
  ])("cleans %j", (input, expected) => {
    expect(prepareForCleanup(input)).toBe(expected);
  });

  it.each([
    "I know that that is true.",
    "She had had enough.",
    "There is one, no doubt about it.",
    "The bolt is 5 mm wide.",
    "Bye bye!",
    "Umbrella and uhlan are words.",
    "I need one. No one else can.",
    "I need one, no one else can.",
  ])("leaves %j alone", (input) => {
    expect(prepareForCleanup(input)).toBe(input);
  });

  it.each([
    ["Wir treffen uns um 8 Uhr, um zu reden.", "de"],
    ["Comprei um carro novo.", "pt"],
    ["Das ist eh egal.", "de"],
  ])("keeps real words in %j (%s)", (input, lang) => {
    expect(prepareForCleanup(input, lang)).toBe(input);
  });
});

describe("looksClean", () => {
  it.each([
    "I'll send the report on Friday.",
    "Can you review the PR before lunch?",
    "Deploy finished at 3:15 PM.",
  ])("skips the model for %j", (t) => {
    expect(looksClean(t)).toBe(true);
  });

  it.each([
    "i'll send the report on friday",
    "I'll send the report on Friday",
    "Um, I'll send it.",
    "Send it to John, sorry, to Jane.",
    "It costs twenty dollars.",
    "We should we should ship.",
    "Meet at three, no, four.",
  ])("sends %j to the model", (t) => {
    expect(looksClean(t)).toBe(false);
  });
});

describe("language", () => {
  it.each([
    ["i think we should ship it on friday with the new build", "en"],
    ["how many days are in a leap year", "en"],
    ["conversion went up by twelve percent last week", null],
    ["je pense que on peut finir demain", "fr"],
    ["on se retrouve à la gare à huit heures", "fr"],
    ["il faut que on envoie le rapport à marie avant vendredi", "fr"],
    ["bueno quería decirte que la reunión es mañana", "es"],
    ["ich glaube das ist nicht richtig", "de"],
  ])("guesses %j as %s", (text, lang) => {
    expect(guessLanguage(text)).toBe(lang);
  });

  it("returns null when it can't tell", () => {
    expect(guessLanguage("ok")).toBeNull();
    expect(guessLanguage("Kubernetes Terraform")).toBeNull();
  });

  it("prefers the engine's detected language over the guess", () => {
    expect(resolveCleanupLanguage("es", "the meeting is at three")).toBe("es");
    expect(resolveCleanupLanguage("auto", "je pense que on peut finir demain")).toBe("fr");
    expect(resolveCleanupLanguage(null, "ok")).toBeUndefined();
  });
});

describe("isLightCleanupMode", () => {
  const base = {
    isBuiltin: true,
    name: "Default",
    systemPrompt: DEFAULT_MODE_PROMPT,
    targetLanguage: null,
  };

  it("accepts the unmodified built-in Default mode", () => {
    expect(isLightCleanupMode(base)).toBe(true);
  });

  it("rejects edited, translating, renamed or custom modes", () => {
    expect(
      isLightCleanupMode({ ...base, systemPrompt: `${DEFAULT_MODE_PROMPT} Use British spelling.` }),
    ).toBe(false);
    expect(isLightCleanupMode({ ...base, targetLanguage: "French" })).toBe(false);
    expect(isLightCleanupMode({ ...base, name: "Formal Email" })).toBe(false);
    expect(isLightCleanupMode({ ...base, isBuiltin: false })).toBe(false);
  });
});
