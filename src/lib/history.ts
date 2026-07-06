/**
 * Transcription history.
 * - Cloud mode: Supabase `transcriptions` table.
 * - Local mode: localStorage list (capped at 500 newest).
 */
import { supabase } from "./supabase";
import { useAuth } from "./store/useAuth";
import { newId, nowIso } from "../types/mode";
import { isLocalMode } from "./appMode";
import { getHistoryRetentionDays } from "./preferences";

const LS_HISTORY = "sw.history.local";
const LOCAL_CAP = 500;

function loadLocal(): Transcription[] {
  try {
    const raw = localStorage.getItem(LS_HISTORY);
    return raw ? (JSON.parse(raw) as Transcription[]) : [];
  } catch {
    return [];
  }
}

function saveLocal(rows: Transcription[]): void {
  const capped = rows.slice(0, LOCAL_CAP);
  localStorage.setItem(LS_HISTORY, JSON.stringify(capped));
}

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
  const row: Transcription = {
    id: newId(),
    user_id: null,
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
  if (isLocalMode()) {
    const next = [row, ...loadLocal()];
    saveLocal(next);
    return row;
  }
  row.user_id = requireUserId();
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
  if (isLocalMode()) {
    let rows = loadLocal();
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.cleaned_text ?? "").toLowerCase().includes(needle) ||
          (r.raw_text ?? "").toLowerCase().includes(needle),
      );
    }
    return rows.slice(0, limit);
  }
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
  if (isLocalMode()) {
    saveLocal(loadLocal().filter((r) => r.id !== id));
    return;
  }
  const { error } = await supabase.from("transcriptions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * Delete transcripts older than the retention window (Settings →
 * Privacy). No-op when retention is "forever". Called on app boot and
 * when the setting changes. Returns the number of rows removed.
 */
export async function pruneExpiredTranscriptions(): Promise<number> {
  const days = getHistoryRetentionDays();
  if (days === null) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  if (isLocalMode()) {
    const rows = loadLocal();
    const kept = rows.filter((r) => r.created_at >= cutoff);
    if (kept.length !== rows.length) saveLocal(kept);
    return rows.length - kept.length;
  }
  const userId = requireUserId();
  const { count, error } = await supabase
    .from("transcriptions")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .lt("created_at", cutoff);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function clearAllTranscriptions(): Promise<void> {
  if (isLocalMode()) {
    localStorage.removeItem(LS_HISTORY);
    return;
  }
  const userId = requireUserId();
  const { error } = await supabase.from("transcriptions").delete().eq("user_id", userId);
  if (error) throw new Error(error.message);
}
