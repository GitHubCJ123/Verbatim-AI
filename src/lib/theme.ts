/**
 * Theme = "dark" | "light" | "system". Persists to localStorage and
 * applies a class on <html> so token CSS picks it up.
 */
import { create } from "zustand";

export type Theme = "dark" | "light" | "system";

const LS_KEY = "sw.theme";

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function resolve(theme: Theme): "dark" | "light" {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

function apply(theme: Theme) {
  const cls = resolve(theme);
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(cls);
  root.style.colorScheme = cls;
}

interface ThemeState {
  theme: Theme;
  set: (t: Theme) => void;
}

function loadInitial(): Theme {
  const raw = localStorage.getItem(LS_KEY);
  if (raw === "dark" || raw === "light" || raw === "system") return raw;
  return "system";
}

export const useTheme = create<ThemeState>((set) => ({
  theme: loadInitial(),
  set: (t) => {
    localStorage.setItem(LS_KEY, t);
    apply(t);
    set({ theme: t });
  },
}));

/** Call once at boot so the class is applied before the first paint. */
export function installTheme() {
  const t = loadInitial();
  apply(t);
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (useTheme.getState().theme === "system") apply("system");
    });
}
