/**
 * One-time migration: copy local-mode data into Supabase under the
 * newly-signed-in user. Triggered by App.tsx after auth state flips
 * to signed-in AND `sw.migration.pending` is set.
 */
import { supabase } from "./supabase";
import { useAuth } from "./store/useAuth";
import { loadModes, loadVocabulary } from "./store/useModes";
import { loadAppMappings } from "./store/useAppMappings";
import type { Mode, VocabularyTerm } from "../types/mode";
import type { AppMapping } from "../types/appMapping";
import type { Transcription } from "./history";

const LS_PENDING = "sw.migration.pending";
const LS_HISTORY = "sw.history.local";

export function markMigrationPending(): void {
  localStorage.setItem(LS_PENDING, "1");
}

export function isMigrationPending(): boolean {
  return localStorage.getItem(LS_PENDING) === "1";
}

function clearLocalAfterMigration(): void {
  localStorage.removeItem(LS_PENDING);
  localStorage.removeItem(LS_HISTORY);
  // Don't wipe sw.modes / sw.vocab / sw.app_mappings — they get
  // overwritten by hydrateAll right after this returns.
}

function modeRow(m: Mode, userId: string) {
  return {
    id: m.id,
    user_id: userId,
    name: m.name,
    icon: m.icon,
    description: m.description,
    system_prompt: m.systemPrompt,
    language: m.language,
    target_language: m.targetLanguage,
    output_style: m.outputStyle,
    hotkey: m.hotkey,
    push_to_talk: m.pushToTalk,
    save_history: m.saveHistory,
    skip_cleanup: m.skipCleanup,
    is_builtin: m.isBuiltin,
    position: m.position,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

function vocabRow(v: VocabularyTerm, userId: string) {
  return {
    id: v.id,
    user_id: userId,
    term: v.term,
    pronunciation: v.pronunciation,
    replacement: v.replacement,
    notes: v.notes,
    created_at: v.createdAt,
  };
}

function appMappingRow(a: AppMapping, userId: string) {
  return {
    id: a.id,
    user_id: userId,
    app_executable: a.appExecutable,
    app_display_name: a.appDisplayName,
    app_icon_path: a.appIconPath,
    mode_id: a.modeId,
    match_window_title: a.matchWindowTitle,
    created_at: a.createdAt,
  };
}

function loadLocalHistory(): Transcription[] {
  try {
    const raw = localStorage.getItem(LS_HISTORY);
    return raw ? (JSON.parse(raw) as Transcription[]) : [];
  } catch {
    return [];
  }
}

export async function migrateLocalToCloud(): Promise<{
  modes: number;
  vocabulary: number;
  appMappings: number;
  transcriptions: number;
}> {
  const userId = useAuth.getState().user?.id;
  if (!userId) throw new Error("Not signed in.");

  const modes = loadModes();
  const vocab = loadVocabulary();
  const mappings = loadAppMappings();
  const history = loadLocalHistory();

  // The DB trigger seeded built-in modes for the new account. Drop the
  // built-ins from our local list so we don't end up with duplicates.
  const userModes = modes.filter((m) => !m.isBuiltin);

  if (userModes.length > 0) {
    const { error } = await supabase.from("modes").insert(userModes.map((m) => modeRow(m, userId)));
    if (error) throw new Error(`modes: ${error.message}`);
  }
  if (vocab.length > 0) {
    const { error } = await supabase.from("vocabulary").insert(vocab.map((v) => vocabRow(v, userId)));
    if (error) throw new Error(`vocabulary: ${error.message}`);
  }
  if (mappings.length > 0) {
    const { error } = await supabase
      .from("app_mappings")
      .insert(mappings.map((a) => appMappingRow(a, userId)));
    if (error) throw new Error(`app_mappings: ${error.message}`);
  }
  if (history.length > 0) {
    const rows = history.map((t) => ({
      ...t,
      user_id: userId,
    }));
    const { error } = await supabase.from("transcriptions").insert(rows);
    if (error) throw new Error(`transcriptions: ${error.message}`);
  }

  clearLocalAfterMigration();

  return {
    modes: userModes.length,
    vocabulary: vocab.length,
    appMappings: mappings.length,
    transcriptions: history.length,
  };
}
