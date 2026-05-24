/**
 * Current user's profile row (mirrors `public.profiles`).
 * Hydrates on sign-in alongside modes/vocab/mappings.
 */
import { create } from "zustand";
import { supabase } from "../supabase";
import { useAuth } from "./useAuth";

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface ProfileState {
  profile: Profile | null;
  loading: boolean;
  hydrate: () => Promise<void>;
  clear: () => void;
  update: (patch: { display_name?: string | null; avatar_url?: string | null }) => Promise<void>;
}

export const useProfile = create<ProfileState>((set) => ({
  profile: null,
  loading: false,

  hydrate: async () => {
    const user = useAuth.getState().user;
    if (!user) {
      set({ profile: null });
      return;
    }
    set({ loading: true });
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,email,display_name,avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      set({ profile: (data as Profile | null) ?? null, loading: false });
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },

  clear: () => set({ profile: null }),

  update: async (patch) => {
    const user = useAuth.getState().user;
    if (!user) throw new Error("Not signed in.");
    const { data, error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", user.id)
      .select("id,email,display_name,avatar_url")
      .single();
    if (error) throw new Error(error.message);
    set({ profile: data as Profile });
  },
}));

/** Best-effort display name from profile, then user.email, then "SW". */
export function displayName(): string {
  const p = useProfile.getState().profile;
  if (p?.display_name) return p.display_name;
  const u = useAuth.getState().user;
  if (u?.email) return u.email.split("@")[0];
  return "SuperWisper";
}

/** Initials for avatar fallback. */
export function initials(): string {
  const name = displayName();
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? "")
      .join("") || "SW"
  );
}
