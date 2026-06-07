/**
 * "What's New" changelog — data-driven, keyed by version.
 *
 * On launch we compare the persisted `sw.lastSeenVersion` against the
 * running app version. If the user skipped one or more releases, the
 * WhatsNewModal lists the highlights for every version in between so an
 * update feels seamless instead of dumping returning users back into
 * onboarding.
 *
 * Adding a release is intentionally trivial: append one entry to
 * `WHATS_NEW` keyed by its version. Each highlight may carry an optional
 * deep link that navigates straight to the relevant screen.
 */

const LS_LAST_SEEN_VERSION = "sw.lastSeenVersion";

/** Optional navigation target for a highlight. */
export interface WhatsNewLink {
  /** Button label, e.g. "Open model settings". */
  label: string;
  /** Router path to navigate to, e.g. "/settings". */
  to: string;
  /** Optional Settings tab to preselect (e.g. "model"). */
  settingsTab?: string;
}

export interface WhatsNewItem {
  title: string;
  description: string;
  link?: WhatsNewLink;
}

export interface WhatsNewEntry {
  version: string;
  /** Human date for display only (optional). */
  date?: string;
  highlights: WhatsNewItem[];
}

/**
 * Changelog content. Append a new entry per release — keep the newest at
 * the top for readability (order here is not significant; selection sorts
 * by version).
 */
export const WHATS_NEW: Record<string, WhatsNewEntry> = {
  "0.5.5": {
    version: "0.5.5",
    date: "2025",
    highlights: [
      {
        title: "Seamless updates",
        description:
          "Updating no longer sends you back through onboarding when you already have a config. You'll see a short summary of what changed — like this — instead.",
      },
      {
        title: "On-device transcription models",
        description:
          "Run speech-to-text fully offline with local Whisper or Parakeet models. Pick your provider and download a model from Settings.",
        link: {
          label: "Open model settings",
          to: "/settings",
          settingsTab: "model",
        },
      },
    ],
  },
};

/**
 * Compare two dotted numeric versions (e.g. "0.5.5").
 * Any pre-release suffix (after `-`) is ignored for ordering.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => {
        const parsed = Number.parseInt(n, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Changelog entries the user hasn't seen yet: every version greater than
 * `lastSeen` (or all of them when `lastSeen` is null) up to and including
 * `current`. Sorted newest-first.
 */
export function getWhatsNewSince(
  lastSeen: string | null,
  current: string,
): WhatsNewEntry[] {
  return Object.values(WHATS_NEW)
    .filter(
      (entry) =>
        compareVersions(entry.version, current) <= 0 &&
        (lastSeen === null || compareVersions(entry.version, lastSeen) > 0),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

export function getLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(LS_LAST_SEEN_VERSION);
  } catch {
    return null;
  }
}

export function setLastSeenVersion(version: string): void {
  try {
    localStorage.setItem(LS_LAST_SEEN_VERSION, version);
  } catch {
    /* localStorage unavailable — non-fatal. */
  }
}

/**
 * Resolve the running app version. Uses the Tauri runtime when available
 * and falls back to the build-time `VITE_APP_VERSION` env (useful in the
 * browser dev server / tests).
 */
export async function getCurrentAppVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    const env = import.meta.env.VITE_APP_VERSION as string | undefined;
    return env ?? null;
  }
}
