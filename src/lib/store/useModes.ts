/**
 * Modes store — Zustand with localStorage persistence.
 *
 * Both Tauri windows share the same origin so `localStorage` is
 * shared. Reads from the *overlay* go through the helper functions
 * (`loadModes`, `getModeById`) so they always see the latest data
 * even though the overlay process keeps its in-memory store alive
 * across recordings.
 */
import { create } from "zustand";
import type { Mode, VocabularyTerm } from "../../types/mode";
import { newId, nowIso } from "../../types/mode";
import { makeBuiltinModes } from "./builtinModes";

const LS_MODES = "sw.modes";
const LS_VOCAB = "sw.vocab";
const LS_DEFAULT_MODE = "sw.modes.default_id";

// ─── Storage helpers (work even when the store isn't mounted) ───────────

export function loadModes(): Mode[] {
  try {
    const raw = localStorage.getItem(LS_MODES);
    if (!raw) {
      const seeded = makeBuiltinModes();
      localStorage.setItem(LS_MODES, JSON.stringify(seeded));
      return seeded;
    }
    return JSON.parse(raw) as Mode[];
  } catch {
    return makeBuiltinModes();
  }
}

function saveModes(modes: Mode[]) {
  localStorage.setItem(LS_MODES, JSON.stringify(modes));
}

export function getModeById(id: string | null | undefined): Mode | null {
  if (!id) return null;
  return loadModes().find((m) => m.id === id) ?? null;
}

export function getDefaultMode(): Mode {
  const all = loadModes();
  const id = localStorage.getItem(LS_DEFAULT_MODE);
  return all.find((m) => m.id === id) ?? all[0];
}

export function setDefaultModeId(id: string) {
  localStorage.setItem(LS_DEFAULT_MODE, id);
}

export function loadVocabulary(): VocabularyTerm[] {
  try {
    const raw = localStorage.getItem(LS_VOCAB);
    return raw ? (JSON.parse(raw) as VocabularyTerm[]) : [];
  } catch {
    return [];
  }
}

function saveVocab(terms: VocabularyTerm[]) {
  localStorage.setItem(LS_VOCAB, JSON.stringify(terms));
}

// ─── Modes Zustand store ────────────────────────────────────────────────

interface ModesState {
  modes: Mode[];
  defaultModeId: string | null;
  create: (input: Partial<Mode> & Pick<Mode, "name">) => Mode;
  update: (id: string, patch: Partial<Mode>) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => Mode | null;
  reorder: (orderedIds: string[]) => void;
  setDefault: (id: string) => void;
  resetToBuiltins: () => void;
}

export const useModes = create<ModesState>((set, get) => {
  const initialModes = loadModes();
  const initialDefault =
    localStorage.getItem(LS_DEFAULT_MODE) ?? initialModes[0]?.id ?? null;

  return {
    modes: initialModes,
    defaultModeId: initialDefault,

    create: (input) => {
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
        isBuiltin: false,
        position: get().modes.length,
        createdAt: now,
        updatedAt: now,
      };
      const next = [...get().modes, mode];
      saveModes(next);
      set({ modes: next });
      return mode;
    },

    update: (id, patch) => {
      const next = get().modes.map((m) =>
        m.id === id ? { ...m, ...patch, updatedAt: nowIso() } : m,
      );
      saveModes(next);
      set({ modes: next });
    },

    remove: (id) => {
      const next = get().modes.filter((m) => m.id !== id);
      saveModes(next);
      set({ modes: next });
      if (get().defaultModeId === id) {
        const fallback = next[0]?.id ?? null;
        if (fallback) localStorage.setItem(LS_DEFAULT_MODE, fallback);
        else localStorage.removeItem(LS_DEFAULT_MODE);
        set({ defaultModeId: fallback });
      }
    },

    duplicate: (id) => {
      const src = get().modes.find((m) => m.id === id);
      if (!src) return null;
      const now = nowIso();
      const copy: Mode = {
        ...src,
        id: newId(),
        name: `${src.name} (copy)`,
        isBuiltin: false,
        position: get().modes.length,
        createdAt: now,
        updatedAt: now,
      };
      const next = [...get().modes, copy];
      saveModes(next);
      set({ modes: next });
      return copy;
    },

    reorder: (orderedIds) => {
      const map = new Map(get().modes.map((m) => [m.id, m]));
      const next = orderedIds
        .map((id, position) => {
          const m = map.get(id);
          return m ? { ...m, position } : null;
        })
        .filter((m): m is Mode => m !== null);
      saveModes(next);
      set({ modes: next });
    },

    setDefault: (id) => {
      localStorage.setItem(LS_DEFAULT_MODE, id);
      set({ defaultModeId: id });
    },

    resetToBuiltins: () => {
      const fresh = makeBuiltinModes();
      saveModes(fresh);
      localStorage.setItem(LS_DEFAULT_MODE, fresh[0].id);
      set({ modes: fresh, defaultModeId: fresh[0].id });
    },
  };
});

// ─── Vocabulary Zustand store ───────────────────────────────────────────

interface VocabularyState {
  terms: VocabularyTerm[];
  add: (input: Pick<VocabularyTerm, "term"> & Partial<VocabularyTerm>) => VocabularyTerm;
  update: (id: string, patch: Partial<VocabularyTerm>) => void;
  remove: (id: string) => void;
  importMany: (terms: Array<Pick<VocabularyTerm, "term"> & Partial<VocabularyTerm>>) => number;
  clear: () => void;
}

export const useVocabulary = create<VocabularyState>((set, get) => ({
  terms: loadVocabulary(),

  add: (input) => {
    const term: VocabularyTerm = {
      id: newId(),
      term: input.term,
      pronunciation: input.pronunciation ?? null,
      notes: input.notes ?? null,
      createdAt: nowIso(),
    };
    const next = [...get().terms, term];
    saveVocab(next);
    set({ terms: next });
    return term;
  },

  update: (id, patch) => {
    const next = get().terms.map((t) => (t.id === id ? { ...t, ...patch } : t));
    saveVocab(next);
    set({ terms: next });
  },

  remove: (id) => {
    const next = get().terms.filter((t) => t.id !== id);
    saveVocab(next);
    set({ terms: next });
  },

  importMany: (inputs) => {
    const additions = inputs
      .filter((i) => i.term && i.term.trim().length > 0)
      .map(
        (i): VocabularyTerm => ({
          id: newId(),
          term: i.term.trim(),
          pronunciation: i.pronunciation ?? null,
          notes: i.notes ?? null,
          createdAt: nowIso(),
        }),
      );
    const next = [...get().terms, ...additions];
    saveVocab(next);
    set({ terms: next });
    return additions.length;
  },

  clear: () => {
    saveVocab([]);
    set({ terms: [] });
  },
}));
