import { create } from "zustand";
import type { AppMapping } from "../../types/appMapping";
import { newId, nowIso } from "../../types/mode";

const LS_KEY = "sw.app_mappings";

export function loadAppMappings(): AppMapping[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as AppMapping[]) : [];
  } catch {
    return [];
  }
}

function save(mappings: AppMapping[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(mappings));
}

interface AppMappingsState {
  mappings: AppMapping[];
  add: (
    input: Pick<AppMapping, "appExecutable" | "appDisplayName"> & Partial<AppMapping>,
  ) => AppMapping;
  update: (id: string, patch: Partial<AppMapping>) => void;
  remove: (id: string) => void;
}

export const useAppMappings = create<AppMappingsState>((set, get) => ({
  mappings: loadAppMappings(),

  add: (input) => {
    const m: AppMapping = {
      id: newId(),
      appExecutable: input.appExecutable.toLowerCase(),
      appDisplayName: input.appDisplayName,
      appIconPath: input.appIconPath ?? null,
      modeId: input.modeId ?? null,
      matchWindowTitle: input.matchWindowTitle ?? null,
      createdAt: nowIso(),
    };
    const next = [...get().mappings, m];
    save(next);
    set({ mappings: next });
    return m;
  },

  update: (id, patch) => {
    const next = get().mappings.map((m) =>
      m.id === id
        ? {
            ...m,
            ...patch,
            appExecutable: (patch.appExecutable ?? m.appExecutable).toLowerCase(),
          }
        : m,
    );
    save(next);
    set({ mappings: next });
  },

  remove: (id) => {
    const next = get().mappings.filter((m) => m.id !== id);
    save(next);
    set({ mappings: next });
  },
}));
