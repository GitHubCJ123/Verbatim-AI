/**
 * Transcription history.
 *
 * - When signed in and Supabase is configured → reads/writes against
 *   `public.transcriptions`.
 * - Otherwise → localStorage under `sw.history`.
 *
 * This is the *only* table we route through Supabase in v1; modes,
 * vocabulary, and app-mappings remain local. Full bi-directional sync
 * for those is deferred.
 */
import { getSupabase } from "./supabase";
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

const LS_KEY = "sw.history";
const LS_LIMIT = 500; // safety cap for local store

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function loadLocal(): Transcription[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Transcription[]) : [];
  } catch {
    return [];
  }
}

function saveLocal(rows: Transcription[]) {
  const trimmed = rows.slice(0, LS_LIMIT);
  localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
}

function isRemoteAvailable(): boolean {
  const client = getSupabase();
  const user = useAuth.getState().user;
  return Boolean(client && user);
}

export async function addTranscription(
  input: CreateTranscriptionInput,
): Promise<Transcription> {
  const row: Transcription = {
    id: newId(),
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

  if (isRemoteAvailable()) {
    const client = getSupabase()!;
    const userId = useAuth.getState().user!.id;
    const { data, error } = await client
      .from("transcriptions")
      .insert({
        // FK to modes is set null since modes stay local-only for now.
        mode_id: null,
        mode_name_snap: row.mode_name_snap,
        raw_text: row.raw_text,
        cleaned_text: row.cleaned_text,
        audio_duration_ms: row.audio_duration_ms,
        word_count: row.word_count,
        app_executable: row.app_executable,
        app_window_title: row.app_window_title,
        output_action: row.output_action,
        language_detected: row.language_detected,
        user_id: userId,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as Transcription;
  }

  const all = loadLocal();
  all.unshift(row);
  saveLocal(all);
  return row;
}

export async function listTranscriptions(opts: { limit?: number; query?: string } = {}): Promise<
  Transcription[]
> {
  const limit = opts.limit ?? 200;
  const q = opts.query?.trim() ?? "";

  if (isRemoteAvailable()) {
    const client = getSupabase()!;
    let query = client
      .from("transcriptions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (q) {
      // Postgres trigram-friendly: ilike on both columns.
      query = query.or(`cleaned_text.ilike.%${q}%,raw_text.ilike.%${q}%`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as Transcription[];
  }

  const all = loadLocal();
  const filtered = q
    ? all.filter((t) => {
        const blob = `${t.cleaned_text ?? ""} ${t.raw_text ?? ""}`.toLowerCase();
        return blob.includes(q.toLowerCase());
      })
    : all;
  return filtered.slice(0, limit);
}

export async function deleteTranscription(id: string): Promise<void> {
  if (isRemoteAvailable()) {
    const client = getSupabase()!;
    const { error } = await client.from("transcriptions").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return;
  }
  const next = loadLocal().filter((t) => t.id !== id);
  saveLocal(next);
}

export async function clearAllTranscriptions(): Promise<void> {
  if (isRemoteAvailable()) {
    const client = getSupabase()!;
    const userId = useAuth.getState().user!.id;
    const { error } = await client.from("transcriptions").delete().eq("user_id", userId);
    if (error) throw new Error(error.message);
    return;
  }
  saveLocal([]);
}
