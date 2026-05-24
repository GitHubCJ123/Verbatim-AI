/**
 * App mode: "local" (no Supabase account, data in localStorage) vs
 * "cloud" (Supabase-backed account + sync).
 *
 * Edge Functions (transcribe / cleanup) are used in BOTH modes — they're
 * the gateway to Azure. In local mode they're called with the anon key
 * instead of a user session JWT. The Edge Functions are deployed with
 * `--no-verify-jwt` so the anon path works.
 */

const LS_APP_MODE = "sw.app.mode";

export type AppMode = "local" | "cloud";

export function getAppMode(): AppMode | null {
  const v = localStorage.getItem(LS_APP_MODE);
  return v === "local" || v === "cloud" ? v : null;
}

export function setAppMode(mode: AppMode): void {
  localStorage.setItem(LS_APP_MODE, mode);
}

export function clearAppMode(): void {
  localStorage.removeItem(LS_APP_MODE);
}

export function isLocalMode(): boolean {
  return getAppMode() === "local";
}

export function isCloudMode(): boolean {
  return getAppMode() === "cloud";
}
