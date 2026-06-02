/**
 * Data-driven "What's New" changelog.
 *
 * Each release appends an entry to {@link WHATS_NEW} keyed by its version
 * string. On launch we compare the last-seen version (persisted in
 * localStorage as `sw.lastSeenVersion`) against the running version and
 * surface a modal listing everything the user skipped. Entries can carry
 * an optional deep link that navigates to the relevant in-app screen.
 *
 * This pairs with the updater release notes (`UpdateStatus.notes` in
 * `./updater.ts`): the updater explains that a new build is available,
 * while this changelog explains what changed once the user is running it.
 */

export const LAST_SEEN_VERSION_KEY = "sw.lastSeenVersion";

export interface WhatsNewItem {
  title: string;
  description: string;
  /** Optional in-app route to jump to, e.g. `"/settings?tab=model"`. */
  deepLink?: string;
  /** Label for the deep-link button. Defaults to "Take me there". */
  deepLinkLabel?: string;
}

export interface WhatsNewEntry {
  /** Optional headline shown above the item list. */
  headline?: string;
  items: WhatsNewItem[];
}

export interface WhatsNewRelease {
  version: string;
  entry: WhatsNewEntry;
}

/**
 * Changelog keyed by version. To announce a release, add an entry here —
 * no other code needs to change.
 */
export const WHATS_NEW: Record<string, WhatsNewEntry> = {
  "0.5.5": {
    headline: "Seamless updates",
    items: [
      {
        title: "Updates no longer reset your setup",
        description:
          "Upgrading keeps your Modes and app mappings exactly as you left them — no more being sent back through onboarding.",
      },
      {
        title: "See what changed at a glance",
        description:
          "This pop-up now appears once after each update to summarize what's new, then gets out of your way.",
      },
      {
        title: "Switch transcription models faster",
        description:
          "Jump straight to model selection to try a different speech-to-text engine.",
        deepLink: "/settings?tab=model",
        deepLinkLabel: "Open model settings",
      },
    ],
  },
};

export function getLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_VERSION_KEY);
  } catch {
    return null;
  }
}

export function setLastSeenVersion(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
  } catch {
    // Best-effort: a failure here just means the modal may reappear.
  }
}

/**
 * Resolve the running app version. Prefers the Tauri runtime version and
 * falls back to the build-time `VITE_APP_VERSION` (and finally `0.0.0`)
 * so the logic still works in a plain browser/dev context.
 */
export async function getCurrentVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    const env = import.meta.env.VITE_APP_VERSION as string | undefined;
    return env ?? "0.0.0";
  }
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Semver-ish numeric compare. Returns -1, 0, or 1. Ignores pre-release tags. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Returns the changelog entries the user hasn't seen yet, newest first.
 *
 * Includes every entry that is newer than `lastSeen` and not newer than
 * `current`. When `lastSeen` is null (e.g. an existing user upgrading into
 * the first build that ships this feature) all entries up to `current` are
 * returned.
 */
export function getWhatsNewSince(
  lastSeen: string | null,
  current: string,
): WhatsNewRelease[] {
  return Object.keys(WHATS_NEW)
    .filter((version) => compareVersions(version, current) <= 0)
    .filter((version) => lastSeen === null || compareVersions(version, lastSeen) > 0)
    .sort((a, b) => compareVersions(b, a))
    .map((version) => ({ version, entry: WHATS_NEW[version] }));
}
