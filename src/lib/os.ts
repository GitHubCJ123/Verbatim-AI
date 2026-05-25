/**
 * Runtime OS detection for OS-aware UI strings.
 *
 * Tauri 2 exposes a proper OS plugin, but we don't want to add a new
 * plugin dep just for a few labels — heuristic over `navigator` is
 * plenty for "what should I show the user".
 */

export type OsKind = "macos" | "windows" | "linux" | "other";

function detect(): OsKind {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent ?? "";
  // userAgentData is the modern API on Chromium-based engines.
  const uaPlat = (navigator as unknown as { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const platform = uaPlat ?? navigator.platform ?? "";
  const blob = `${ua} ${platform}`.toLowerCase();
  if (blob.includes("mac") || blob.includes("darwin")) return "macos";
  if (blob.includes("win")) return "windows";
  if (blob.includes("linux")) return "linux";
  return "other";
}

const KIND = detect();

export function osKind(): OsKind {
  return KIND;
}

export function isMac(): boolean {
  return KIND === "macos";
}

export function isWindows(): boolean {
  return KIND === "windows";
}

/** Display name, e.g. "Windows", "macOS". */
export function osName(): string {
  switch (KIND) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "your computer";
  }
}

/** Native settings app name. */
export function settingsAppName(): string {
  return KIND === "macos" ? "System Settings" : "Settings";
}

/** Path users type/click to reach mic permissions in their OS settings. */
export function micPermissionPath(): string {
  return KIND === "macos"
    ? "System Settings → Privacy & Security → Microphone"
    : "Windows Settings → Privacy → Microphone";
}

/** Native clipboard-history shortcut, where one exists. */
export function clipboardHistoryHint(): string {
  return KIND === "macos"
    ? "macOS doesn't ship a clipboard history natively."
    : "Windows already keeps clipboard history (press Win+V to view it).";
}
