/**
 * Supabase client — built once at module load from VITE_* env vars.
 * SuperWisper is online-only; if either var is missing the app shows
 * a fatal error screen instead of trying to start.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(URL && ANON_KEY);

export const supabase: SupabaseClient = isSupabaseConfigured
  ? createClient(URL!, ANON_KEY!, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : (null as unknown as SupabaseClient);

export function getSupabase(): SupabaseClient | null {
  return isSupabaseConfigured ? supabase : null;
}

export function supabaseUrl(): string {
  return URL ?? "";
}

export function supabaseAnonKey(): string {
  return ANON_KEY ?? "";
}
