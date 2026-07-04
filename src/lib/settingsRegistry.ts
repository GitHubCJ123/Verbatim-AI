/**
 * Searchable registry of every setting and destination in the app
 * (docs/improvement-plan/02-settings-ux.md, step 1).
 *
 * Single source of truth for the Cmd+K palette. Entries with a `tab`
 * live inside /settings and deep-link as
 * `/settings?tab=<tab>&highlight=<id>` — Settings.tsx switches to the
 * tab, scrolls the row into view, and flashes it. Entries with a
 * `route` are plain pages.
 *
 * When adding a SettingRow, add an entry here and pass the same `id`
 * to the row.
 */

export type SettingsTab =
  | "general"
  | "model"
  | "recording"
  | "overlay"
  | "privacy"
  | "advanced";

export interface SettingsSearchEntry {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  tab?: SettingsTab;
  route?: string;
}

export function entryHref(e: SettingsSearchEntry): string {
  if (e.tab) return `/settings?tab=${e.tab}&highlight=${e.id}`;
  return e.route ?? "/";
}

export const SETTINGS_ENTRIES: SettingsSearchEntry[] = [
  // General
  {
    id: "autostart",
    title: "Launch at startup",
    description: "Open Verbatim AI when your computer starts.",
    keywords: ["boot", "login", "autostart", "startup", "launch"],
    tab: "general",
  },
  {
    id: "theme",
    title: "Theme",
    description: "Dark, light, or match the system.",
    keywords: ["dark mode", "light mode", "appearance", "color"],
    tab: "general",
  },
  {
    id: "version",
    title: "Version",
    description: "The version of Verbatim AI currently running.",
    keywords: ["about", "build", "release"],
    tab: "general",
  },
  {
    id: "updates",
    title: "App updates",
    description: "Check for and install new versions.",
    keywords: ["upgrade", "update", "new version", "install"],
    tab: "general",
  },
  // AI model
  {
    id: "transcription-provider",
    title: "Transcription provider",
    description: "Where speech-to-text runs: cloud, local Whisper, or Parakeet.",
    keywords: ["ai", "whisper", "parakeet", "local", "cloud", "offline", "speech to text", "model", "privacy"],
    tab: "model",
  },
  {
    id: "cleanup-provider",
    title: "Cleanup provider",
    description: "Where tone polish and grammar fixes run: cloud or local Ollama.",
    keywords: ["ai", "ollama", "polish", "llm", "grammar", "local", "cloud", "improve"],
    tab: "model",
  },
  {
    id: "transcription-language",
    title: "Transcription language",
    description: "Pick a language or let the model auto-detect.",
    keywords: ["language", "locale", "auto detect", "accent"],
    tab: "model",
  },
  // Recording
  {
    id: "hotkey",
    title: "Global hotkey",
    description: "The shortcut you hold to dictate from anywhere.",
    keywords: ["shortcut", "keybinding", "key", "fn", "hold", "trigger", "record"],
    tab: "recording",
  },
  {
    id: "microphone",
    title: "Microphone",
    description: "Input device used for recording.",
    keywords: ["mic", "input", "audio device", "headset"],
    tab: "recording",
  },
  {
    id: "push-to-talk",
    title: "Push-to-talk",
    description: "Hold to record, or tap to toggle.",
    keywords: ["ptt", "hold", "toggle", "tap", "hands free"],
    tab: "recording",
  },
  // Overlay
  {
    id: "overlay-position",
    title: "Overlay position",
    description: "Where the recording pill appears on screen.",
    keywords: ["pill", "popup", "corner", "screen position", "widget"],
    tab: "overlay",
  },
  {
    id: "clipboard-restore",
    title: "Restore clipboard after paste",
    description: "Put your previous clipboard back after text is pasted.",
    keywords: ["clipboard", "paste", "copy", "restore"],
    tab: "overlay",
  },
  // Privacy
  {
    id: "history-save",
    title: "Save transcription history",
    description: "Keep past transcripts on the History page, or store nothing.",
    keywords: ["privacy", "history", "transcripts", "storage", "delete", "retention"],
    tab: "privacy",
  },
  {
    id: "history-retention",
    title: "History retention",
    description: "Auto-delete transcripts older than 7/30/90 days.",
    keywords: ["privacy", "retention", "auto delete", "purge", "cleanup", "expire", "old transcripts"],
    tab: "privacy",
  },
  {
    id: "telemetry",
    title: "Anonymous telemetry",
    description: "Usage stats — never your transcript content.",
    keywords: ["privacy", "analytics", "tracking", "data collection"],
    tab: "privacy",
  },
  // Advanced
  {
    id: "log-level",
    title: "Log level",
    description: "Verbosity of log files.",
    keywords: ["logs", "debug", "verbose", "troubleshoot"],
    tab: "advanced",
  },
  {
    id: "test-ai",
    title: "Test AI connection",
    description: "Verify the transcription and cleanup backends respond.",
    keywords: ["connection", "health", "ping", "azure", "ollama", "debug", "not working"],
    tab: "model",
  },
  {
    id: "rerun-onboarding",
    title: "Re-run onboarding",
    description: "Go through the setup flow again.",
    keywords: ["setup", "wizard", "start over", "tutorial", "reset"],
    tab: "advanced",
  },
  {
    id: "devtools",
    title: "Open developer tools",
    description: "Inspect the app's web views.",
    keywords: ["debug", "console", "inspector"],
    tab: "advanced",
  },
  // Pages
  {
    id: "page-home",
    title: "Home",
    description: "Dashboard and recent transcriptions.",
    keywords: ["dashboard", "start", "overview"],
    route: "/",
  },
  {
    id: "page-modes",
    title: "Modes",
    description: "Edit the styles your speech is rewritten in.",
    keywords: ["tone", "style", "prompt", "presets", "formal", "casual"],
    route: "/modes",
  },
  {
    id: "page-apps",
    title: "Apps",
    description: "Map applications to Modes automatically.",
    keywords: ["per app", "mapping", "rules", "slack", "email", "automatic mode"],
    route: "/apps",
  },
  {
    id: "page-vocabulary",
    title: "Vocabulary",
    description: "Words to spell correctly — names, acronyms, brands.",
    keywords: ["dictionary", "terms", "spelling", "names", "replacement"],
    route: "/vocabulary",
  },
  {
    id: "page-history",
    title: "History",
    description: "Search and reuse past transcripts.",
    keywords: ["past", "transcripts", "search", "log"],
    route: "/history",
  },
  {
    id: "page-account",
    title: "Account",
    description: "Sign-in, sync, and account data.",
    keywords: ["profile", "sign out", "login", "sync", "email", "delete account"],
    route: "/account",
  },
];

/** Simple fuzzy-ish filter: every whitespace-separated token must match
 *  the title, description, or a keyword (substring, case-insensitive).
 *  Title matches rank first. */
export function searchSettings(query: string): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_ENTRIES;
  const tokens = q.split(/\s+/);
  const scored: Array<{ e: SettingsSearchEntry; score: number }> = [];
  for (const e of SETTINGS_ENTRIES) {
    const title = e.title.toLowerCase();
    const hay = `${title} ${e.description.toLowerCase()} ${e.keywords.join(" ").toLowerCase()}`;
    if (!tokens.every((t) => hay.includes(t))) continue;
    let score = 0;
    if (tokens.some((t) => title.includes(t))) score += 2;
    if (title.startsWith(tokens[0])) score += 1;
    scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.e);
}
