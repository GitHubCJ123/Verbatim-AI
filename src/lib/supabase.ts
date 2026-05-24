/**
 * Supabase client (lazy — only constructed when the user has filled in
 * URL + anon key in Settings → Sync). URL/anon-key are public-by-design
 * so localStorage is fine for them (RLS protects the actual data).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const LS_KEY = "sw.supabase.config";

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function loadSupabaseConfig(): Partial<SupabaseConfig> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<SupabaseConfig>;
  } catch {
    return {};
  }
}

export function saveSupabaseConfig(cfg: Partial<SupabaseConfig>): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export function isConfigured(cfg: Partial<SupabaseConfig>): cfg is SupabaseConfig {
  return Boolean(cfg.url && cfg.anonKey);
}

let cached: { url: string; anonKey: string; client: SupabaseClient } | null = null;

export function getSupabase(): SupabaseClient | null {
  const cfg = loadSupabaseConfig();
  if (!isConfigured(cfg)) {
    cached = null;
    return null;
  }
  if (cached && cached.url === cfg.url && cached.anonKey === cfg.anonKey) {
    return cached.client;
  }
  const client = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  cached = { url: cfg.url, anonKey: cfg.anonKey, client };
  return client;
}

/** Reset the memoized client; call after the user changes URL/anon key. */
export function resetSupabase(): void {
  cached = null;
}
