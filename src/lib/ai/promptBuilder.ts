/**
 * Templates the system prompt sent to the cleanup LLM.
 * Mirrors the spec in plan §11 ("Prompt builder").
 */
import type { CleanupInput } from "./AIProvider";

export interface PromptBundle {
  system: string;
  user: string;
}

export function buildCleanupPrompt(input: CleanupInput): PromptBundle {
  const vocab =
    input.vocabulary && input.vocabulary.length > 0
      ? input.vocabulary.map((t) => `- ${t}`).join("\n")
      : "(none provided)";

  const translationLine = input.targetLanguage
    ? `\n- Translate the result into ${input.targetLanguage} naturally.`
    : "";

  const system = [
    `You are Verbatim AI's polishing layer for the "${input.modeName}" mode.`,
    "",
    input.modeDescription ? `Goal: ${input.modeDescription}` : "",
    "",
    "Specialized vocabulary the user often uses (preserve exact spelling):",
    vocab,
    "",
    "Rules:",
    "- Preserve the speaker's intent and voice.",
    '- Remove disfluencies ("um", "uh", false starts, repeated words).',
    "- Fix grammar and punctuation.",
    `- ${input.systemPrompt}${translationLine}`,
    "",
    "Return ONLY the polished text. No commentary, no quotes.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return {
    system,
    user: `RAW TRANSCRIPT:\n${input.rawText}`,
  };
}

/** Crude token estimate: ~4 chars per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
