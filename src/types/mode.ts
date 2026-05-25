/**
 * Domain types for Verbatim AI. These mirror the SQL columns from
 * plan §7 so the same shape works for localStorage, SQLite (Phase 10),
 * and Supabase (Phase 9).
 */

export type OutputStyle = "paste" | "review";

/** Override fields that let a Mode pin its own AI providers / models.
 * Null on any of these means "inherit the global setting from
 * Settings → AI model". When set, the Mode always wins over the global. */
export type TranscribeProviderKind = "cloud" | "local-whisper";
export type WhisperTierKind = "tiny" | "base" | "small" | "turbo" | "large-v3";
export type CleanupProviderKind = "cloud" | "local-ollama";

export interface Mode {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPrompt: string;
  language: string;
  targetLanguage: string | null;
  outputStyle: OutputStyle;
  hotkey: string | null;
  pushToTalk: boolean;
  saveHistory: boolean;
  skipCleanup: boolean;
  isBuiltin: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;

  // AI overrides — null means inherit global.
  transcribeProviderOverride: TranscribeProviderKind | null;
  whisperTierOverride: WhisperTierKind | null;
  cleanupProviderOverride: CleanupProviderKind | null;
  ollamaModelOverride: string | null;
}

export interface VocabularyTerm {
  id: string;
  term: string;
  pronunciation: string | null;
  replacement: string | null;
  notes: string | null;
  createdAt: string;
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
