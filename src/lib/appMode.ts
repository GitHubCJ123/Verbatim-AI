/**
 * App mode: "local" (no Supabase account, data in localStorage) vs
 * "cloud" (Supabase-backed account + sync).
 *
 * Edge Functions (transcribe / cleanup) can be used in BOTH modes when
 * cloud AI is enabled. Local mode keeps data local, but cloud AI calls
 * still mint a Supabase anonymous session so Edge Functions can enforce
 * per-user quota instead of accepting the baked public anon key as bearer.
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
