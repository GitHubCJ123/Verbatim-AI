import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  initialized: boolean;
  init: () => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUpWithPassword: (email: string, password: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

function requireClient() {
  const c = getSupabase();
  if (!c) throw new Error("Supabase is not configured. Add your URL + anon key in Settings → Sync.");
  return c;
}

export const useAuth = create<AuthState>((set) => ({
  session: null,
  user: null,
  loading: false,
  initialized: false,

  init: async () => {
    const client = getSupabase();
    if (!client) {
      set({ session: null, user: null, initialized: true });
      return;
    }
    const { data } = await client.auth.getSession();
    set({
      session: data.session,
      user: data.session?.user ?? null,
      initialized: true,
    });
    client.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null });
    });
  },

  signInWithPassword: async (email, password) => {
    set({ loading: true });
    try {
      const client = requireClient();
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } finally {
      set({ loading: false });
    }
  },

  signUpWithPassword: async (email, password) => {
    set({ loading: true });
    try {
      const client = requireClient();
      const { error } = await client.auth.signUp({ email, password });
      if (error) throw error;
    } finally {
      set({ loading: false });
    }
  },

  resetPassword: async (email) => {
    const client = requireClient();
    const { error } = await client.auth.resetPasswordForEmail(email);
    if (error) throw error;
  },

  signOut: async () => {
    const client = getSupabase();
    if (!client) return;
    await client.auth.signOut();
    set({ session: null, user: null });
  },
}));
