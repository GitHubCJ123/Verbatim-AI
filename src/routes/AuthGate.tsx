/**
 * Full-window auth gate. Shown when there's no active Supabase session.
 * Email + password only (it's a native app — no magic-link redirects).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, Loader2, AlertCircle } from "lucide-react";
import { Card, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useAuth } from "../lib/store/useAuth";
import { isOnboardingComplete } from "../lib/store/useOnboarding";
import { toast } from "../components/ui/Toast";

export default function AuthGate() {
  return (
    <div
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-bg-base text-text-primary"
      style={{ backgroundImage: "radial-gradient(80% 60% at 50% 0%, rgba(168, 85, 247, 0.18), transparent 70%)" }}
    >
      <div className="w-full max-w-md px-6">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-lg2 bg-gradient-to-br from-accent-start to-accent-end shadow-glow">
            <Mic className="h-6 w-6 text-white" strokeWidth={2.25} />
          </div>
          <h1 className="bg-gradient-to-r from-accent-start to-accent-end bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
            Verbatim AI
          </h1>
          <p className="mt-2 text-sm text-text-secondary">Sign in to start dictating.</p>
        </div>
        <Card>
          <CardContent className="p-6 pt-6">
            <PasswordForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PasswordForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = useAuth((s) => s.signInWithPassword);
  const signUp = useAuth((s) => s.signUpWithPassword);
  const resetPassword = useAuth((s) => s.resetPassword);
  const navigate = useNavigate();

  const friendly = (raw: string): string => {
    const m = raw.toLowerCase();
    if (m.includes("invalid login credentials")) return "Wrong email or password. If you haven't signed up yet, switch to Create account below.";
    if (m.includes("user already registered") || m.includes("already registered")) return "An account with this email already exists. Try signing in instead.";
    if (m.includes("email not confirmed")) return "This email hasn't been confirmed yet.";
    if (m.includes("password") && m.includes("6")) return "Password must be at least 6 characters.";
    if (m.includes("rate limit")) return "Too many attempts. Wait a minute and try again.";
    return raw;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") {
        await signIn(email, password);
        toast.success("Signed in");
      } else {
        await signUp(email, password);
        toast.success("Account created");
      }
      // Auth listener in App.tsx also handles this, but navigate explicitly
      // so we don't depend on subscriber ordering.
      if (useAuth.getState().user) {
        navigate(mode === "signup" || !isOnboardingComplete() ? "/onboarding" : "/", {
          replace: true,
        });
      } else if (mode === "signup") {
        setError(
          "Account created but no session was returned. Check your Supabase Auth settings (email confirmation should be off).",
        );
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(friendly(raw));
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!email) {
      setError("Enter your email first, then click \"Forgot password\".");
      return;
    }
    try {
      await resetPassword(email);
      setError(null);
      toast.success("Password reset email sent");
    } catch (err) {
      setError(friendly(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-3 py-2">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <label className="text-xs text-text-secondary">Email</label>
      <Input
        type="email"
        autoFocus
        required
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <label className="text-xs text-text-secondary">Password</label>
      <Input
        type="password"
        required
        minLength={6}
        placeholder="••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button variant="primary" type="submit" disabled={busy || !email || !password} className="mt-1">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {mode === "signin" ? "Sign in" : "Create account"}
      </Button>
      <div className="mt-1 flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
          className="text-text-secondary hover:text-text-primary"
        >
          {mode === "signin" ? "Create an account" : "Have an account? Sign in"}
        </button>
        {mode === "signin" && (
          <button
            type="button"
            onClick={forgot}
            className="text-text-secondary hover:text-text-primary"
          >
            Forgot password?
          </button>
        )}
      </div>
    </form>
    </>
  );
}
