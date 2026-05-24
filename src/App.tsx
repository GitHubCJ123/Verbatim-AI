import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider, Navigate } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import Home from "./routes/Home";
import Modes from "./routes/Modes";
import ModeEditor from "./routes/ModeEditor";
import Apps from "./routes/Apps";
import Vocabulary from "./routes/Vocabulary";
import History from "./routes/History";
import Settings from "./routes/Settings";
import Account from "./routes/Account";
import Onboarding from "./routes/onboarding/Onboarding";
import AuthGate from "./routes/AuthGate";
import ModePicker from "./routes/ModePicker";
import { isOnboardingComplete } from "./lib/store/useOnboarding";
import { isSupabaseConfigured } from "./lib/supabase";
import { useAuth } from "./lib/store/useAuth";
import { hydrateAll, clearAllCaches } from "./lib/store/useModes";
import { useAppMappings } from "./lib/store/useAppMappings";
import { useProfile } from "./lib/store/useProfile";
import { getAppMode } from "./lib/appMode";
import { isMigrationPending, migrateLocalToCloud } from "./lib/migration";
import { toast } from "./components/ui/Toast";
import { Loader2, AlertTriangle } from "lucide-react";
import { Toaster } from "./components/ui/Toast";

function FatalConfig() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-base px-6 text-text-primary">
      <div className="max-w-md rounded-lg2 border border-danger/30 bg-danger/5 p-6">
        <div className="flex items-center gap-2 text-danger">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm font-semibold">Configuration missing</span>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          Verbatim AI needs <code className="font-mono text-xs">VITE_SUPABASE_URL</code> and{" "}
          <code className="font-mono text-xs">VITE_SUPABASE_ANON_KEY</code> in{" "}
          <code className="font-mono text-xs">.env.local</code>. Set them and restart.
        </p>
      </div>
    </div>
  );
}

function BootSpinner() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-base text-text-secondary">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

const router = createMemoryRouter(
  [
    { path: "/picker", element: <ModePicker /> },
    { path: "/auth", element: <AuthGate /> },
    { path: "/onboarding", element: <Onboarding /> },
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <Home /> },
        { path: "modes", element: <Modes /> },
        { path: "modes/editor", element: <ModeEditor /> },
        { path: "apps", element: <Apps /> },
        { path: "vocabulary", element: <Vocabulary /> },
        { path: "history", element: <History /> },
        { path: "settings", element: <Settings /> },
        { path: "account", element: <Account /> },
      ],
    },
    { path: "*", element: <Navigate to="/" replace /> },
  ],
  { initialEntries: ["/picker"] },
);

export default function App() {
  const [phase, setPhase] = useState<"boot" | "ready">("boot");
  const [hydrationError, setHydrationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isSupabaseConfigured) {
      setPhase("ready");
      return;
    }

    void (async () => {
      // One-time wipe of legacy keys from the local-mode era.
      if (localStorage.getItem("sw.online.migrated") !== "v2") {
        for (const k of [
          "sw.azure.config",
          "sw.supabase.config",
          "sw.history",
        ]) {
          localStorage.removeItem(k);
        }
        localStorage.setItem("sw.online.migrated", "v2");
      }

      const mode = getAppMode();
      if (mode === null) {
        // First launch — route to picker.
        if (!cancelled) {
          router.navigate("/picker", { replace: true });
          setPhase("ready");
        }
        return;
      }

      if (mode === "local") {
        // Local mode: no auth, hydrate from localStorage (seeds built-ins).
        try {
          await hydrateAll();
          await useAppMappings.getState().hydrate();
        } catch (e) {
          setHydrationError(e instanceof Error ? e.message : String(e));
        }
        if (!cancelled) {
          router.navigate(isOnboardingComplete() ? "/" : "/onboarding", { replace: true });
          setPhase("ready");
        }
        return;
      }

      // Cloud mode.
      await useAuth.getState().init();

      // Subscribe to subsequent auth changes so caches stay in sync.
      useAuth.subscribe((state, prev) => {
        if (state.user && state.user.id !== prev.user?.id) {
          void (async () => {
            try {
              if (isMigrationPending()) {
                const result = await migrateLocalToCloud();
                const total =
                  result.modes + result.vocabulary + result.appMappings + result.transcriptions;
                if (total > 0) {
                  toast.success(
                    `Migrated ${result.modes} modes, ${result.vocabulary} terms, ${result.appMappings} app rules, ${result.transcriptions} transcripts`,
                  );
                }
              }
            } catch (e) {
              toast.error("Migration failed", {
                description: e instanceof Error ? e.message : String(e),
              });
            }
            try {
              await hydrateAll();
              await useAppMappings.getState().hydrate();
              await useProfile.getState().hydrate();
            } catch (e) {
              setHydrationError(e instanceof Error ? e.message : String(e));
            }
            router.navigate(isOnboardingComplete() ? "/" : "/onboarding", { replace: true });
          })();
        }
        if (!state.user && prev.user) {
          clearAllCaches();
          useAppMappings.getState().clear();
          useProfile.getState().clear();
          router.navigate("/auth", { replace: true });
        }
      });

      const user = useAuth.getState().user;
      if (user) {
        try {
          await Promise.all([
            hydrateAll(),
            useAppMappings.getState().hydrate(),
            useProfile.getState().hydrate(),
          ]);
        } catch (e) {
          setHydrationError(e instanceof Error ? e.message : String(e));
        }
        if (!cancelled) {
          router.navigate(isOnboardingComplete() ? "/" : "/onboarding", { replace: true });
        }
      } else if (!cancelled) {
        // Cloud mode, signed out — go to auth gate.
        router.navigate("/auth", { replace: true });
      }

      if (!cancelled) setPhase("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!isSupabaseConfigured) return <FatalConfig />;
  if (phase === "boot") return <BootSpinner />;
  // Note: hydrationError is shown via toasts inside the running app; we
  // still render so the user can sign out or retry from Account.
  if (hydrationError) console.warn("[Verbatim AI] hydration error:", hydrationError);
  return (
    <>
      <Toaster />
      <RouterProvider router={router} />
    </>
  );
}
