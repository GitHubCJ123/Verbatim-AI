/**
 * Deterministic work done before the cleanup model runs.
 *
 * `prepareForCleanup` removes what a regex can remove reliably (fillers,
 * stutters, "three no four" number corrections), which helps small models.
 * `looksClean` decides when the model can be skipped entirely: speech
 * engines already punctuate, so a transcript with nothing left to fix is
 * pasted with no added delay.
 */
import type { Mode } from "../../types/mode";
import { DEFAULT_MODE_PROMPT } from "../store/builtinModes";

const FILLER = String.raw`(?:um+|uh+|uhm+|erm+|eh|euh|hmm+)`;
/** "um" and "eh" are real words in German/Portuguese ("um 8 Uhr", "um carro"). */
const SAFE_FILLER = String.raw`(?:umm+|uh+|uhm+|erm+|euh|hmm+)`;

function fillerRx(language: string | undefined): RegExp {
  const filler = language === "de" || language === "pt" ? SAFE_FILLER : FILLER;
  return new RegExp(String.raw`(^|[\s,])${filler}(?:,(?=\s|$))?(?=[\s,.!?]|$)`, "giu");
}

const NUMBER_WORD = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|\d+(?:[:.]\d+)?)`;
const NUMBER = String.raw`${NUMBER_WORD}(?:\s+${NUMBER_WORD})?`;
const CORRECTION = String.raw`(?:no|sorry|i mean|actually|wait)`;
/** Commas only, so a match never spans sentences; "no one" is not a correction. */
const NUMBER_CORRECTION_RX = new RegExp(
  String.raw`\b${NUMBER},?\s+(?!no,?\s+one\b)${CORRECTION},?\s+(${NUMBER})\b`,
  "giu",
);

/** Words whose doubling is often grammatical ("that that", "had had", "die, die"). */
const LEGIT_DOUBLES = new Set([
  "that",
  "had",
  "is",
  "do",
  "very",
  "really",
  "so",
  "bye",
  "no",
  "die",
  "der",
  "das",
  "que",
  "nous",
  "vous",
]);

function collapseStutters(text: string): string {
  let out = text.replace(/\b(\p{L}+(?:'\p{L}+)?(?:\s+\p{L}+(?:'\p{L}+)?){1,2})\s+\1\b/giu, "$1");
  out = out.replace(/\b(\p{L}+(?:'\p{L}+)?)\s+\1\b/giu, (whole, word: string) =>
    LEGIT_DOUBLES.has(word.toLowerCase()) ? whole : word,
  );
  return out;
}

export function prepareForCleanup(text: string, language?: string): string {
  let out = text.replace(fillerRx(language), "$1");
  out = out.replace(NUMBER_CORRECTION_RX, "$1");
  out = collapseStutters(out);
  return out
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[\s,]+/, "")
    .replace(/,\s*,/g, ",")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const NEEDS_MODEL_RX = new RegExp(
  [
    String.raw`\b${FILLER}\b`,
    String.raw`\b(?:no|sorry|i mean|actually|wait|scratch that|rather|or rather)\b`,
    String.raw`\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|percent|dollars?|euros?|pounds?)\b`,
    String.raw`\b(\p{L}+(?:\s+\p{L}+){0,2})\s+\1\b`,
  ].join("|"),
  "iu",
);

/**
 * True when the transcript already reads as typed text: capitalized,
 * punctuated, and free of fillers, repeats, corrections and spelled-out
 * numbers. Deliberately conservative — anything doubtful goes to the model.
 */
export function looksClean(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (!/^[\p{Lu}\d"'(]/u.test(t)) return false;
  if (!/[.!?…]["')]?$/u.test(t)) return false;
  return !NEEDS_MODEL_RX.test(t);
}

/**
 * Function words per language. Words shared with English (or each other)
 * like "a", "o", "e", "in", "is" are left out so they can't tip the guess.
 */
const STOPWORDS: Record<string, string[]> = Object.fromEntries(
  Object.entries({
    en: "the and to of it that you we i this for with can are how what my your will just have be at",
    es: "el los las que y es por para con una nos pero muy está del al",
    fr: "le les et est que je nous vous pour une pas on avec qu à au du des mais ça",
    de: "der die das und ist ich nicht wir mit ein eine zu auf auch",
    it: "il che di è non per sono gli ci lo della questo anche molto",
    pt: "não uma com os você eu muito isso também está são obrigado",
    nl: "het een ik niet van dat met voor ook maar wij zijn deze",
  }).map(([lang, words]) => [lang, words.split(" ")]),
);

/** Best-guess language from common function words; null when unclear. */
export function guessLanguage(text: string): string | null {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 2) return null;
  let best: string | null = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  return bestScore > 0 && bestScore > runnerUp ? best : null;
}

/** The engine's detected language when it reports one, else a guess. */
export function resolveCleanupLanguage(
  detected: string | null | undefined,
  text: string,
): string | undefined {
  const code = detected?.trim().toLowerCase().slice(0, 2);
  if (code && /^[a-z]{2}$/.test(code) && detected?.toLowerCase() !== "auto") return code;
  return guessLanguage(text) ?? undefined;
}

const LIGHT_PROMPTS = new Set([
  DEFAULT_MODE_PROMPT,
  "Make minimal changes. Fix obvious mistakes only. Keep the speaker's word choice.",
]);

/** The unmodified built-in Default mode: minimal edits, no restyling. */
export function isLightCleanupMode(
  mode: Pick<Mode, "isBuiltin" | "name" | "systemPrompt" | "targetLanguage">,
): boolean {
  return (
    mode.isBuiltin &&
    mode.name === "Default" &&
    !mode.targetLanguage &&
    LIGHT_PROMPTS.has(mode.systemPrompt.trim())
  );
}
