/**
 * App-mapping store — Supabase source of truth, localStorage cache for
 * the hotkey hot path (overlay/main reads via `loadAppMappings`).
 */
import { create } from "zustand";
import type { AppMapping } from "../../types/appMapping";
import { newId, nowIso } from "../../types/mode";
import { supabase } from "../supabase";
import { useAuth } from "./useAuth";

const LS_KEY = "sw.app_mappings";

interface RemoteRow {
  id: string;
  user_id: string;
  app_executable: string;
  app_display_name: string;
  app_icon_path: string | null;
  mode_id: string | null;
  match_window_title: string | null;
  created_at: string;
}

function rowToMapping(r: RemoteRow): AppMapping {
  return {
    id: r.id,
    appExecutable: r.app_executable,
    appDisplayName: r.app_display_name,
    appIconPath: r.app_icon_path,
    modeId: r.mode_id,
    matchWindowTitle: r.match_window_title,
    createdAt: r.created_at,
  };
}

function saveCache(rows: AppMapping[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(rows));
}

export function loadAppMappings(): AppMapping[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as AppMapping[]) : [];
  } catch {
    return [];
  }
}

function requireUserId(): string {
  const id = useAuth.getState().user?.id;
  if (!id) throw new Error("Not signed in.");
  return id;
}

interface AppMappingsState {
  mappings: AppMapping[];
  loading: boolean;
  hydrate: () => Promise<void>;
  clear: () => void;
  add: (
    input: Pick<AppMapping, "appExecutable" | "appDisplayName"> & Partial<AppMapping>,
  ) => Promise<AppMapping>;
  update: (id: string, patch: Partial<AppMapping>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useAppMappings = create<AppMappingsState>((set, get) => ({
  mappings: loadAppMappings(),
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    try {
      const { data, error } = await supabase
        .from("app_mappings")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      const rows = (data as RemoteRow[]).map(rowToMapping);
      saveCache(rows);
      set({ mappings: rows, loading: false });
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },

  clear: () => {
    localStorage.removeItem(LS_KEY);
    set({ mappings: [] });
  },

  add: async (input) => {
    const userId = requireUserId();
    const m: AppMapping = {
      id: newId(),
      appExecutable: input.appExecutable.toLowerCase(),
      appDisplayName: input.appDisplayName,
      appIconPath: input.appIconPath ?? null,
      modeId: input.modeId ?? null,
      matchWindowTitle: input.matchWindowTitle ?? null,
      createdAt: nowIso(),
    };
    const { error } = await supabase.from("app_mappings").insert({
      id: m.id,
      user_id: userId,
      app_executable: m.appExecutable,
      app_display_name: m.appDisplayName,
      app_icon_path: m.appIconPath,
      mode_id: m.modeId,
      match_window_title: m.matchWindowTitle,
      created_at: m.createdAt,
    });
    if (error) throw new Error(error.message);
    const next = [...get().mappings, m];
    saveCache(next);
    set({ mappings: next });
    return m;
  },

  update: async (id, patch) => {
    const cur = get().mappings.find((m) => m.id === id);
    if (!cur) return;
    const merged = { ...cur, ...patch };
    if (patch.appExecutable) merged.appExecutable = patch.appExecutable.toLowerCase();
    const { error } = await supabase
      .from("app_mappings")
      .update({
        app_executable: merged.appExecutable,
        app_display_name: merged.appDisplayName,
        app_icon_path: merged.appIconPath,
        mode_id: merged.modeId,
        match_window_title: merged.matchWindowTitle,
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
    const next = get().mappings.map((m) => (m.id === id ? merged : m));
    saveCache(next);
    set({ mappings: next });
  },

  remove: async (id) => {
    const { error } = await supabase.from("app_mappings").delete().eq("id", id);
    if (error) throw new Error(error.message);
    const next = get().mappings.filter((m) => m.id !== id);
    saveCache(next);
    set({ mappings: next });
  },
}));
