/**
 * Transcription history — Supabase only (online-only architecture).
 */
import { supabase } from "./supabase";
import { useAuth } from "./store/useAuth";
import { newId, nowIso } from "../types/mode";

export type OutputAction = "pasted" | "reviewed" | "copied" | "discarded";

export interface Transcription {
  id: string;
  user_id?: string | null;
  mode_id: string | null;
  mode_name_snap: string | null;
  raw_text: string | null;
  cleaned_text: string | null;
  audio_duration_ms: number | null;
  word_count: number | null;
  app_executable: string | null;
  app_window_title: string | null;
  output_action: OutputAction | null;
  language_detected: string | null;
  created_at: string;
}

export interface CreateTranscriptionInput {
  modeId: string | null;
  modeNameSnap?: string | null;
  rawText: string;
  cleanedText: string;
  audioDurationMs?: number | null;
  appExecutable?: string | null;
  appWindowTitle?: string | null;
  outputAction?: OutputAction | null;
  languageDetected?: string | null;
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function requireUserId(): string {
  const id = useAuth.getState().user?.id;
  if (!id) throw new Error("Not signed in.");
  return id;
}

export async function addTranscription(
  input: CreateTranscriptionInput,
): Promise<Transcription> {
  const userId = requireUserId();
  const row: Transcription = {
    id: newId(),
    user_id: userId,
    mode_id: input.modeId,
    mode_name_snap: input.modeNameSnap ?? null,
    raw_text: input.rawText,
    cleaned_text: input.cleanedText,
    audio_duration_ms: input.audioDurationMs ?? null,
    word_count: countWords(input.cleanedText || input.rawText || ""),
    app_executable: input.appExecutable ?? null,
    app_window_title: input.appWindowTitle ?? null,
    output_action: input.outputAction ?? null,
    language_detected: input.languageDetected ?? null,
    created_at: nowIso(),
  };
  const { data, error } = await supabase
    .from("transcriptions")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Transcription;
}

export async function listTranscriptions(
  opts: { limit?: number; query?: string } = {},
): Promise<Transcription[]> {
  const limit = opts.limit ?? 200;
  const q = opts.query?.trim() ?? "";
  let query = supabase
    .from("transcriptions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (q) query = query.or(`cleaned_text.ilike.%${q}%,raw_text.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Transcription[];
}

export async function deleteTranscription(id: string): Promise<void> {
  const { error } = await supabase.from("transcriptions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function clearAllTranscriptions(): Promise<void> {
  const userId = requireUserId();
  const { error } = await supabase.from("transcriptions").delete().eq("user_id", userId);
  if (error) throw new Error(error.message);
}
