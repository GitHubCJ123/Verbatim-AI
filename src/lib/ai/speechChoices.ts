/**
 * The short, curated list of speech-to-text choices shown to users.
 *
 * Settings used to expose two engines × six Whisper tiers × two Parakeet
 * variants × four compute backends. Almost everyone needs one of three
 * answers, so the primary picker offers exactly those; the full matrix stays
 * available under "Advanced".
 *
 * - Parakeet v3 is the default: on the warm sidecar it transcribes a few
 *   seconds of speech in a few hundred ms on CPU alone, with punctuation, for
 *   English and 24 other European languages.
 * - Whisper Turbo covers every other language and uses the GPU where there
 *   is one (Metal / CUDA / Vulkan).
 * - Whisper Base is the small download for old or low-memory machines.
 */
import type { AiProviderKind, WhisperModelId } from "./localWhisper";
import type { ParakeetVariant } from "./parakeet";

export type SpeechChoiceId = "parakeet-v3" | "whisper-turbo" | "whisper-base";

export interface SpeechChoice {
  id: SpeechChoiceId;
  title: string;
  tagline: string;
  detail: string;
  approxSizeMB: number;
  recommended?: boolean;
  engine: Extract<AiProviderKind, "local-whisper" | "local-parakeet">;
  /** Whisper tier, for `engine === "local-whisper"`. */
  tier?: WhisperModelId;
  /** Parakeet variant, for `engine === "local-parakeet"`. */
  variant?: ParakeetVariant;
}

export const SPEECH_CHOICES: SpeechChoice[] = [
  {
    id: "parakeet-v3",
    title: "Fast & accurate",
    tagline: "Parakeet · English + 24 European languages",
    detail: "Best speed and accuracy for most people. Runs on any modern CPU.",
    approxSizeMB: 640,
    recommended: true,
    engine: "local-parakeet",
    variant: "v3",
  },
  {
    id: "whisper-turbo",
    title: "Every language",
    tagline: "Whisper Turbo · 99 languages",
    detail: "Pick this for languages Parakeet doesn't cover. Uses your GPU when available.",
    approxSizeMB: 547,
    engine: "local-whisper",
    tier: "turbo",
  },
  {
    id: "whisper-base",
    title: "Lightweight",
    tagline: "Whisper Base · small download",
    detail: "For older or low-memory computers. Noticeably less accurate.",
    approxSizeMB: 142,
    engine: "local-whisper",
    tier: "base",
  },
];

export const DEFAULT_SPEECH_CHOICE: SpeechChoiceId = "parakeet-v3";

export function speechChoiceById(id: SpeechChoiceId): SpeechChoice {
  return SPEECH_CHOICES.find((c) => c.id === id) ?? SPEECH_CHOICES[0];
}

/**
 * Which curated choice the current settings correspond to, or `null` when the
 * user configured something else under Advanced (another tier, Parakeet v2,
 * a custom model, …).
 */
export function currentSpeechChoice(
  kind: AiProviderKind,
  whisperTier: WhisperModelId,
  parakeetVariant: ParakeetVariant,
): SpeechChoiceId | null {
  for (const c of SPEECH_CHOICES) {
    if (c.engine !== kind) continue;
    if (c.engine === "local-parakeet" && c.variant === parakeetVariant) return c.id;
    if (c.engine === "local-whisper" && c.tier === whisperTier) return c.id;
  }
  return null;
}

export interface SpeechInstallState {
  whisperRuntime: boolean;
  whisperTiers: Partial<Record<string, boolean>>;
  parakeetRuntime: boolean;
  parakeetVariants: Partial<Record<ParakeetVariant, boolean>>;
}

/** True when everything the choice needs is already on disk. */
export function isSpeechChoiceInstalled(c: SpeechChoice, s: SpeechInstallState): boolean {
  if (c.engine === "local-parakeet") {
    return s.parakeetRuntime && !!s.parakeetVariants[c.variant ?? "v3"];
  }
  return s.whisperRuntime && !!s.whisperTiers[c.tier ?? "turbo"];
}
