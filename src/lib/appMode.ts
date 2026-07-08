/**
 * App mode: "local" (no Supabase account, data in localStorage) vs
 * "cloud" (Supabase-backed account + sync).
 *
 * Edge Functions (transcribe / cleanup) are used in BOTH modes — they're
 * the gateway to Azure. In local mode they're called with the anon key
 * instead of a user session JWT. The Edge Functions are deployed with
 * `--no-verify-jwt` so the anon path works.
 */

import { CLOUD_FEATURES_ENABLED } from "./features";

const LS_APP_MODE = "sw.app.mode";

export type AppMode = "local" | "cloud";

/**
 * Raw persisted app mode, ignoring the cloud feature flag. Kept so a
 * future re-enable can honor a previously-chosen "cloud" account without
 * having overwritten it while cloud was disabled.
 */
export function getStoredAppMode(): AppMode | null {
  const v = localStorage.getItem(LS_APP_MODE);
  return v === "local" || v === "cloud" ? v : null;
}

export function getAppMode(): AppMode | null {
  // Cloud disabled → force local-only everywhere (boot, hydration, nav)
  // without mutating the stored value, so re-enabling is a clean flip.
  if (!CLOUD_FEATURES_ENABLED) return "local";
  return getStoredAppMode();
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
