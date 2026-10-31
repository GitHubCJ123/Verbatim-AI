import { PARAKEET_LANGUAGES } from "../../lib/ai/parakeet";
import { speechChoiceById } from "../../lib/ai/speechChoices";

// Unknown or mixed languages need Whisper's broader coverage, not a
// European-only recommendation inferred from the interface language.
export function recommendedSpeechChoice(language: string) {
  const european = language !== "auto" && PARAKEET_LANGUAGES.some((l) => l.code === language);
  return speechChoiceById(european ? "parakeet-v3" : "whisper-turbo");
}
