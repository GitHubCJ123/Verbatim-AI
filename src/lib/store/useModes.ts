/**
 * Modes + Vocabulary stores — Supabase is the source of truth.
 *
 * localStorage acts as a write-through cache so the overlay window
 * (separate JS context, hotkey-press hot path) can read synchronously
 * without going to the network. Whenever the main window mutates
 * data, we update Supabase, then refresh the cache via `hydrateAll`.
 */
import { create } from "zustand";
import type { Mode, VocabularyTerm } from "../../types/mode";
import { newId, nowIso } from "../../types/mode";
import { supabase } from "../supabase";
import { useAuth } from "./useAuth";
import { isLocalMode } from "../appMode";
import { buildBuiltinModes } from "./builtinModes";

const LS_MODES = "sw.modes";
const LS_VOCAB = "sw.vocab";
const LS_DEFAULT_MODE = "sw.modes.default_id";

// ─── Storage helpers (sync reads for the overlay) ─────────────────────

export function loadModes(): Mode[] {
  try {
    const raw = localStorage.getItem(LS_MODES);
    return raw ? (JSON.parse(raw) as Mode[]) : [];
  } catch {
    return [];
  }
}

function saveModesCache(modes: Mode[]) {
  localStorage.setItem(LS_MODES, JSON.stringify(modes));
}

export function getModeById(id: string | null | undefined): Mode | null {
  if (!id) return null;
  return loadModes().find((m) => m.id === id) ?? null;
}

export function getDefaultMode(): Mode | null {
  const all = loadModes();
  if (all.length === 0) return null;
  const id = localStorage.getItem(LS_DEFAULT_MODE);
  return all.find((m) => m.id === id) ?? all[0];
}

export function loadVocabulary(): VocabularyTerm[] {
  try {
    const raw = localStorage.getItem(LS_VOCAB);
    return raw ? (JSON.parse(raw) as VocabularyTerm[]) : [];
  } catch {
    return [];
  }
}

function saveVocabCache(terms: VocabularyTerm[]) {
  localStorage.setItem(LS_VOCAB, JSON.stringify(terms));
}

// ─── Supabase row → domain mapping ────────────────────────────────────

interface RemoteMode {
  id: string;
  user_id: string;
  name: string;
  icon: string | null;
  description: string | null;
  system_prompt: string;
  language: string;
  target_language: string | null;
  output_style: "paste" | "review";
  hotkey: string | null;
  push_to_talk: boolean;
  save_history: boolean;
  skip_cleanup: boolean;
  is_builtin: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  transcribe_provider: "cloud" | "local-whisper" | "local-parakeet" | null;
  whisper_tier: "tiny" | "base" | "small" | "turbo" | "large-v3" | null;
  cleanup_provider: "cloud" | "local-ollama" | null;
  ollama_model: string | null;
}

function rowToMode(r: RemoteMode): Mode {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon ?? "Sparkles",
    description: r.description ?? "",
    systemPrompt: r.system_prompt,
    language: r.language ?? "auto",
    targetLanguage: r.target_language,
    outputStyle: r.output_style,
    hotkey: r.hotkey,
    pushToTalk: r.push_to_talk,
    saveHistory: r.save_history,
    skipCleanup: r.skip_cleanup ?? false,
    isBuiltin: r.is_builtin,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    transcribeProviderOverride: r.transcribe_provider ?? null,
    whisperTierOverride: r.whisper_tier ?? null,
    cleanupProviderOverride: r.cleanup_provider ?? null,
    ollamaModelOverride: r.ollama_model ?? null,
  };
}

function modeToRow(m: Mode, userId: string): RemoteMode {
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
    transcribe_provider: m.transcribeProviderOverride,
    whisper_tier: m.whisperTierOverride,
    cleanup_provider: m.cleanupProviderOverride,
    ollama_model: m.ollamaModelOverride,
  };
}

interface RemoteVocab {
  id: string;
  user_id: string;
  term: string;
  pronunciation: string | null;
  replacement: string | null;
  notes: string | null;
  created_at: string;
}

function rowToVocab(r: RemoteVocab): VocabularyTerm {
  return {
    id: r.id,
    term: r.term,
    pronunciation: r.pronunciation,
    replacement: r.replacement,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

// ─── Zustand stores ───────────────────────────────────────────────────

interface ModesState {
  modes: Mode[];
  defaultModeId: string | null;
  loading: boolean;
  hydrate: () => Promise<void>;
  clear: () => void;
  create: (input: Partial<Mode> & Pick<Mode, "name">) => Promise<Mode>;
  update: (id: string, patch: Partial<Mode>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<Mode | null>;
  reorder: (orderedIds: string[]) => Promise<void>;
  setDefault: (id: string) => void;
}

function requireUserId(): string {
  const id = useAuth.getState().user?.id;
  if (!id) throw new Error("Not signed in.");
  return id;
}

export const useModes = create<ModesState>((set, get) => ({
  modes: loadModes(),
  defaultModeId: localStorage.getItem(LS_DEFAULT_MODE),
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    try {
      if (isLocalMode()) {
        let modes = loadModes();
        if (modes.length === 0) {
          modes = buildBuiltinModes();
          saveModesCache(modes);
        }
        const stored = localStorage.getItem(LS_DEFAULT_MODE);
        const defId = modes.some((m) => m.id === stored)
          ? stored
          : (modes[0]?.id ?? null);
        if (defId) localStorage.setItem(LS_DEFAULT_MODE, defId);
        set({ modes, defaultModeId: defId, loading: false });
        return;
      }
      const { data, error } = await supabase
        .from("modes")
        .select("*")
        .order("position", { ascending: true });
      if (error) throw new Error(error.message);
      const modes = (data as RemoteMode[]).map(rowToMode);
      saveModesCache(modes);
      const stored = localStorage.getItem(LS_DEFAULT_MODE);
      const defId = modes.some((m) => m.id === stored)
        ? stored
        : (modes[0]?.id ?? null);
      if (defId) localStorage.setItem(LS_DEFAULT_MODE, defId);
      set({ modes, defaultModeId: defId, loading: false });
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },

  clear: () => {
    localStorage.removeItem(LS_MODES);
    localStorage.removeItem(LS_DEFAULT_MODE);
    set({ modes: [], defaultModeId: null });
  },

  create: async (input) => {
    const now = nowIso();
    const mode: Mode = {
      id: newId(),
      name: input.name,
      icon: input.icon ?? "Sparkles",
      description: input.description ?? "",
      systemPrompt: input.systemPrompt ?? "Clean up the transcript.",
      language: input.language ?? "auto",
      targetLanguage: input.targetLanguage ?? null,
      outputStyle: input.outputStyle ?? "paste",
      hotkey: input.hotkey ?? null,
      pushToTalk: input.pushToTalk ?? true,
      saveHistory: input.saveHistory ?? true,
      skipCleanup: input.skipCleanup ?? false,
      isBuiltin: false,
      position: get().modes.length,
      createdAt: now,
      updatedAt: now,
      transcribeProviderOverride: input.transcribeProviderOverride ?? null,
      whisperTierOverride: input.whisperTierOverride ?? null,
      cleanupProviderOverride: input.cleanupProviderOverride ?? null,
      ollamaModelOverride: input.ollamaModelOverride ?? null,
    };
    if (isLocalMode()) {
      const next = [...get().modes, mode];
      saveModesCache(next);
      set({ modes: next });
      return mode;
    }
    const userId = requireUserId();
    const { error } = await supabase.from("modes").insert(modeToRow(mode, userId));
    if (error) throw new Error(error.message);
    const next = [...get().modes, mode];
    saveModesCache(next);
    set({ modes: next });
    return mode;
  },

  update: async (id, patch) => {
    const updated = nowIso();
    const cur = get().modes.find((m) => m.id === id);
    if (!cur) return;
    const merged = { ...cur, ...patch, updatedAt: updated };
    if (isLocalMode()) {
      const next = get().modes.map((m) => (m.id === id ? merged : m));
      saveModesCache(next);
      set({ modes: next });
      return;
    }
    const userId = requireUserId();
    const { error } = await supabase
      .from("modes")
      .update(modeToRow(merged, userId))
      .eq("id", id);
    if (error) throw new Error(error.message);
    const next = get().modes.map((m) => (m.id === id ? merged : m));
    saveModesCache(next);
    set({ modes: next });
  },

  remove: async (id) => {
    if (!isLocalMode()) {
      const { error } = await supabase.from("modes").delete().eq("id", id);
      if (error) throw new Error(error.message);
    }
    const next = get().modes.filter((m) => m.id !== id);
    saveModesCache(next);
    set({ modes: next });
    if (get().defaultModeId === id) {
      const fallback = next[0]?.id ?? null;
      if (fallback) localStorage.setItem(LS_DEFAULT_MODE, fallback);
      else localStorage.removeItem(LS_DEFAULT_MODE);
      set({ defaultModeId: fallback });
    }
  },

  duplicate: async (id) => {
    const src = get().modes.find((m) => m.id === id);
    if (!src) return null;
    return get().create({
      ...src,
      name: `${src.name} (copy)`,
    });
  },

  reorder: async (orderedIds) => {
    const map = new Map(get().modes.map((m) => [m.id, m]));
    const next: Mode[] = orderedIds
      .map((id, position) => {
        const m = map.get(id);
        return m ? { ...m, position, updatedAt: nowIso() } : null;
      })
      .filter((m): m is Mode => m !== null);
    saveModesCache(next);
    set({ modes: next });
    if (isLocalMode()) return;
    const userId = requireUserId();
    // Bulk position update — one round trip per mode is fine for small N.
    await Promise.all(
      next.map((m) =>
        supabase
          .from("modes")
          .update({ position: m.position, updated_at: m.updatedAt })
          .eq("id", m.id)
          .eq("user_id", userId),
      ),
    );
  },

  setDefault: (id) => {
    localStorage.setItem(LS_DEFAULT_MODE, id);
    set({ defaultModeId: id });
  },
}));

// ─── Vocabulary ───────────────────────────────────────────────────────

interface VocabularyState {
  terms: VocabularyTerm[];
  loading: boolean;
  hydrate: () => Promise<void>;
  clear: () => void;
  add: (input: Pick<VocabularyTerm, "term"> & Partial<VocabularyTerm>) => Promise<VocabularyTerm>;
  update: (id: string, patch: Partial<VocabularyTerm>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  importMany: (inputs: Array<Pick<VocabularyTerm, "term"> & Partial<VocabularyTerm>>) => Promise<number>;
}

export const useVocabulary = create<VocabularyState>((set, get) => ({
  terms: loadVocabulary(),
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    try {
      if (isLocalMode()) {
        set({ terms: loadVocabulary(), loading: false });
        return;
      }
      const { data, error } = await supabase
        .from("vocabulary")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      const terms = (data as RemoteVocab[]).map(rowToVocab);
      saveVocabCache(terms);
      set({ terms, loading: false });
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },

  clear: () => {
    localStorage.removeItem(LS_VOCAB);
    set({ terms: [] });
  },

  add: async (input) => {
    const t: VocabularyTerm = {
      id: newId(),
      term: input.term,
      pronunciation: input.pronunciation ?? null,
      replacement: input.replacement ?? null,
      notes: input.notes ?? null,
      createdAt: nowIso(),
    };
    if (isLocalMode()) {
      const next = [...get().terms, t];
      saveVocabCache(next);
      set({ terms: next });
      return t;
    }
    const userId = requireUserId();
    const { error } = await supabase.from("vocabulary").insert({
      id: t.id,
      user_id: userId,
      term: t.term,
      pronunciation: t.pronunciation,
      replacement: t.replacement,
      notes: t.notes,
      created_at: t.createdAt,
    });
    if (error) throw new Error(error.message);
    const next = [...get().terms, t];
    saveVocabCache(next);
    set({ terms: next });
    return t;
  },

  update: async (id, patch) => {
    const cur = get().terms.find((t) => t.id === id);
    if (!cur) return;
    const merged = { ...cur, ...patch };
    if (isLocalMode()) {
      const next = get().terms.map((t) => (t.id === id ? merged : t));
      saveVocabCache(next);
      set({ terms: next });
      return;
    }
    const { error } = await supabase
      .from("vocabulary")
      .update({
        term: merged.term,
        pronunciation: merged.pronunciation ?? null,
        replacement: merged.replacement ?? null,
        notes: merged.notes ?? null,
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
    const next = get().terms.map((t) => (t.id === id ? merged : t));
    saveVocabCache(next);
    set({ terms: next });
  },

  remove: async (id) => {
    if (!isLocalMode()) {
      const { error } = await supabase.from("vocabulary").delete().eq("id", id);
      if (error) throw new Error(error.message);
    }
    const next = get().terms.filter((t) => t.id !== id);
    saveVocabCache(next);
    set({ terms: next });
  },

  importMany: async (inputs) => {
    const cleaned = inputs.filter((i) => i.term && i.term.trim().length > 0);
    if (cleaned.length === 0) return 0;
    if (isLocalMode()) {
      const additions: VocabularyTerm[] = cleaned.map((i) => ({
        id: newId(),
        term: i.term.trim(),
        pronunciation: i.pronunciation ?? null,
        replacement: i.replacement ?? null,
        notes: i.notes ?? null,
        createdAt: nowIso(),
      }));
      const next = [...get().terms, ...additions];
      saveVocabCache(next);
      set({ terms: next });
      return additions.length;
    }
    const userId = requireUserId();
    const additions = cleaned.map((i) => ({
      id: newId(),
      user_id: userId,
      term: i.term.trim(),
      pronunciation: i.pronunciation ?? null,
      replacement: i.replacement ?? null,
      notes: i.notes ?? null,
      created_at: nowIso(),
    }));
    const { error } = await supabase.from("vocabulary").insert(additions);
    if (error) throw new Error(error.message);
    await get().hydrate();
    return additions.length;
  },
}));

// ─── Convenience hydrate-everything ──────────────────────────────────

export async function hydrateAll(): Promise<void> {
  if (isLocalMode()) {
    await Promise.all([useModes.getState().hydrate(), useVocabulary.getState().hydrate()]);
    return;
  }
  if (!useAuth.getState().user) return;
  await Promise.all([useModes.getState().hydrate(), useVocabulary.getState().hydrate()]);
}

export function clearAllCaches(): void {
  useModes.getState().clear();
  useVocabulary.getState().clear();
}
