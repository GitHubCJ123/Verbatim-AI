/**
 * Every built-in speech-to-text model, with measured accuracy and speed.
 *
 * Each model stores the figures from one benchmark run: 200 LibriSpeech
 * test-other utterances (23.7 min, CC BY 4.0) on an Apple M1 Pro, 5 threads.
 * Parakeet and Canary run on the CPU (that is how the app runs them);
 * Whisper uses the Metal GPU. The 0-10 scores are computed from those
 * figures so they can't drift from them. Engines are an implementation
 * detail; users pick a model.
 */
import type { AiProviderKind, WhisperModelId } from "./localWhisper";
import type { ParakeetVariant } from "./parakeet";

export type SpeechChoiceId =
  | "parakeet-v3"
  | "parakeet-v2"
  | "canary-180m-flash"
  | "whisper-turbo"
  | "whisper-large-v3"
  | "whisper-large-v3-q5_0"
  | "whisper-small"
  | "whisper-base"
  | "whisper-tiny";

/** 0-10: 10 at 0% word error rate, 0 at 15% or worse. */
export function accuracyScore(werPct: number): number {
  return Math.round(Math.max(0, Math.min(10, 10 * (1 - werPct / 15))) * 10) / 10;
}

/** 0-10: 10 at instant, 0 at 4.5 s or more to transcribe 10 s of speech. */
export function speedScore(secondsPer10s: number): number {
  return Math.round(Math.max(0, Math.min(10, 10 * (1 - secondsPer10s / 4.5))) * 10) / 10;
}

interface SpeechChoiceSpec {
  id: SpeechChoiceId;
  name: string;
  tagline: string;
  /** Short language chip, e.g. "English only", "25 languages". */
  languages: string;
  approxSizeMB: number;
  recommended?: boolean;
  /** Needs a spoken language picked (no auto-detect). */
  needsLanguage?: boolean;
  engine: Extract<AiProviderKind, "local-whisper" | "local-parakeet">;
  tier?: WhisperModelId;
  variant?: ParakeetVariant;
  /** Word error rate on the benchmark, percent. */
  werPct: number;
  /** Seconds of compute per 10 s of speech on the benchmark machine. */
  secondsPer10s: number;
}

export interface SpeechChoice extends SpeechChoiceSpec {
  /** 0-10, from `werPct`. */
  quality: number;
  /** 0-10, from `secondsPer10s`. */
  speed: number;
}

const SPECS: SpeechChoiceSpec[] = [
  {
    id: "parakeet-v3",
    name: "Parakeet v3",
    tagline: "Fast and accurate in English and 24 other European languages. Detects the language.",
    languages: "25 languages",
    approxSizeMB: 487,
    recommended: true,
    engine: "local-parakeet",
    variant: "v3",
    werPct: 4.18,
    secondsPer10s: 2.84,
  },
  {
    id: "parakeet-v2",
    name: "Parakeet v2",
    tagline: "The English-only Parakeet. More accurate in English than v3.",
    languages: "English only",
    approxSizeMB: 482,
    engine: "local-parakeet",
    variant: "v2",
    werPct: 2.71,
    secondsPer10s: 2.85,
  },
  {
    id: "canary-180m-flash",
    name: "Canary 180M Flash",
    tagline: "Tiny and quick, runs well on any hardware. Tell it which language you speak.",
    languages: "4 languages",
    approxSizeMB: 154,
    needsLanguage: true,
    engine: "local-parakeet",
    variant: "canary-180m-flash",
    werPct: 3.65,
    secondsPer10s: 1.1,
  },
  {
    id: "whisper-turbo",
    name: "Whisper Turbo",
    tagline: "OpenAI Whisper large-v3 turbo. Covers 99 languages and uses your GPU.",
    languages: "99 languages",
    approxSizeMB: 547,
    engine: "local-whisper",
    tier: "turbo",
    werPct: 3.17,
    secondsPer10s: 2.69,
  },
  {
    id: "whisper-large-v3",
    name: "Whisper Large v3",
    tagline: "The full-size Whisper. Most accurate here and strong on rare languages; very large.",
    languages: "99 languages",
    approxSizeMB: 3100,
    engine: "local-whisper",
    tier: "large-v3",
    werPct: 2.4,
    secondsPer10s: 3.06,
  },
  {
    id: "whisper-large-v3-q5_0",
    name: "Whisper Large v3 (compact)",
    tagline: "Large v3 compressed to a third of the size, with the same accuracy but slower.",
    languages: "99 languages",
    approxSizeMB: 1080,
    engine: "local-whisper",
    tier: "large-v3-q5_0",
    werPct: 2.43,
    secondsPer10s: 3.91,
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    tagline: "Mid-size Whisper: quick, with noticeable mistakes on hard audio.",
    languages: "99 languages",
    approxSizeMB: 466,
    engine: "local-whisper",
    tier: "small",
    werPct: 6.17,
    secondsPer10s: 0.64,
  },
  {
    id: "whisper-base",
    name: "Whisper Base",
    tagline: "Small download for low-memory computers. Noticeably less accurate.",
    languages: "99 languages",
    approxSizeMB: 142,
    engine: "local-whisper",
    tier: "base",
    werPct: 9.8,
    secondsPer10s: 0.25,
  },
  {
    id: "whisper-tiny",
    name: "Whisper Tiny",
    tagline: "Smallest and fastest Whisper. Makes frequent mistakes.",
    languages: "99 languages",
    approxSizeMB: 75,
    engine: "local-whisper",
    tier: "tiny",
    werPct: 13.64,
    secondsPer10s: 0.16,
  },
];

export const SPEECH_CHOICES: SpeechChoice[] = SPECS.map((s) => ({
  ...s,
  quality: accuracyScore(s.werPct),
  speed: speedScore(s.secondsPer10s),
}));

export const DEFAULT_SPEECH_CHOICE: SpeechChoiceId = "parakeet-v3";

export function speechChoiceById(id: SpeechChoiceId): SpeechChoice {
  return SPEECH_CHOICES.find((c) => c.id === id) ?? SPEECH_CHOICES[0];
}

/**
 * Which model the current settings point at, or `null` for a setup the list
 * doesn't cover (a custom Whisper file, cloud).
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
