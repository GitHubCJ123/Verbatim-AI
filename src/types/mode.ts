/**
 * Domain types for SuperWisper. These mirror the SQL columns from
 * plan §7 so the same shape works for localStorage, SQLite (Phase 10),
 * and Supabase (Phase 9).
 */

export type OutputStyle = "paste" | "review";

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
