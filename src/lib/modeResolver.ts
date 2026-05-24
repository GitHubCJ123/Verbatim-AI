/**
 * Mode resolution — plan §8.3.
 *
 * At hotkey-press time, look up the foreground app in `app_mappings`.
 * Match by `app_executable` (case-insensitive). If `match_window_title`
 * is set, treat it as a regex and require the active window title to
 * match. Fall back to the user's default Mode if nothing matches.
 */
import type { Mode } from "../types/mode";
import type { AppMapping } from "../types/appMapping";
import { getDefaultMode, getModeById, loadModes } from "./store/useModes";
import { loadAppMappings } from "./store/useAppMappings";
import { getActiveWindow, type ActiveWindow } from "./hotkey";

export function resolveModeFor(
  activeWindow: ActiveWindow | null,
  mappings: AppMapping[],
  modes: Mode[],
): Mode {
  if (!activeWindow || !activeWindow.exe) return getDefaultMode();
  const exe = activeWindow.exe.toLowerCase();

  const candidates = mappings.filter((m) => m.appExecutable === exe);
  if (candidates.length === 0) return getDefaultMode();

  // Prefer the one with a matching title regex, then a non-title-bound one.
  for (const c of candidates) {
    if (!c.matchWindowTitle) continue;
    try {
      const re = new RegExp(c.matchWindowTitle, "i");
      if (re.test(activeWindow.title)) {
        const m = modes.find((x) => x.id === c.modeId);
        if (m) return m;
      }
    } catch {
      // ignore bad regex
    }
  }
  const fallback = candidates.find((c) => !c.matchWindowTitle);
  if (fallback) {
    const m = modes.find((x) => x.id === fallback.modeId);
    if (m) return m;
  }
  return getDefaultMode();
}

/**
 * Read everything from storage and resolve fresh — used by the hotkey
 * handler (no React subscriptions in that path).
 */
export async function resolveModeAtPress(): Promise<{
  mode: Mode;
  activeWindow: ActiveWindow | null;
}> {
  let aw: ActiveWindow | null = null;
  try {
    aw = await getActiveWindow();
  } catch {
    aw = null;
  }
  const mode = resolveModeFor(aw, loadAppMappings(), loadModes());
  return { mode, activeWindow: aw };
}

export function modeForId(id: string | null | undefined): Mode | null {
  return getModeById(id);
}
