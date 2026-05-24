import { useState } from "react";
import { Loader2, LogOut, Mail, KeyRound } from "lucide-react";
import { Card, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Avatar, AvatarFallback } from "../components/ui/Avatar";
import { Badge } from "../components/ui/Badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/Tabs";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { useAuth } from "../lib/store/useAuth";
import { isConfigured, loadSupabaseConfig } from "../lib/supabase";
import { toast } from "../components/ui/Toast";

export default function Account() {
  const user = useAuth((s) => s.user);
  const supabaseReady = isConfigured(loadSupabaseConfig());

  if (!supabaseReady) {
    return (
      <PageContainer>
        <PageHeader
          title="Account"
          description="Sign in to sync your transcript history across devices."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-12 pt-12 text-center">
            <Avatar className="h-16 w-16">
              <AvatarFallback>?</AvatarFallback>
            </Avatar>
            <div>
              <div className="text-base font-semibold">Supabase not configured</div>
              <div className="mt-1 max-w-sm text-xs text-text-secondary">
                Add your Supabase URL + anon key in Settings → Sync to enable accounts.
              </div>
            </div>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }

  if (user) return <SignedInView />;
  return <AuthView />;
}

function SignedInView() {
  const user = useAuth((s) => s.user)!;
  const signOut = useAuth((s) => s.signOut);
  const initials = user.email
    ? user.email
        .split("@")[0]
        .split(/[._-]/)
        .slice(0, 2)
        .map((s) => s[0]?.toUpperCase() ?? "")
        .join("") || "SW"
    : "SW";

  return (
    <PageContainer>
      <PageHeader title="Account" description="You're signed in. Your transcripts sync to Supabase." />
      <Card>
        <CardContent className="flex items-center gap-5 p-6 pt-6">
          <Avatar className="h-14 w-14">
            <AvatarFallback className="text-base">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <div className="text-base font-semibold">{user.email}</div>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant="success">Signed in</Badge>
              <span className="text-xs text-text-muted">id: {user.id.slice(0, 8)}…</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => signOut().then(() => toast.success("Signed out"))}>
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </PageContainer>
  );
}

function AuthView() {
  return (
    <PageContainer className="max-w-lg">
      <PageHeader title="Sign in" description="Sync transcripts across devices." />
      <Card>
        <CardContent className="p-6 pt-6">
          <Tabs defaultValue="magic">
            <TabsList className="w-full">
              <TabsTrigger value="magic" className="flex-1">
                <Mail className="mr-1.5 h-3.5 w-3.5" />
                Magic link
              </TabsTrigger>
              <TabsTrigger value="password" className="flex-1">
                <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                Password
              </TabsTrigger>
            </TabsList>
            <TabsContent value="magic">
              <MagicLinkForm />
            </TabsContent>
            <TabsContent value="password">
              <PasswordForm />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </PageContainer>
  );
}

function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const signInWithMagicLink = useAuth((s) => s.signInWithMagicLink);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      await signInWithMagicLink(email);
      setSent(true);
      toast.success("Magic link sent", { description: `Check ${email}` });
    } catch (err) {
      toast.error("Couldn't send link", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Mail className="h-8 w-8 text-accent-start" />
        <div className="text-sm font-medium">Check your inbox</div>
        <div className="max-w-xs text-xs text-text-secondary">
          We sent a sign-in link to <span className="text-text-primary">{email}</span>. Click it and
          you'll be redirected back here.
        </div>
        <Button variant="ghost" size="sm" onClick={() => setSent(false)}>
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 py-2">
      <label className="text-xs text-text-secondary">Email</label>
      <Input
        type="email"
        autoFocus
        required
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Button variant="primary" type="submit" disabled={busy || !email} className="mt-1">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Send magic link
      </Button>
    </form>
  );
}

function PasswordForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const signIn = useAuth((s) => s.signInWithPassword);
  const signUp = useAuth((s) => s.signUpWithPassword);
  const resetPassword = useAuth((s) => s.resetPassword);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
        toast.success("Signed in");
      } else {
        await signUp(email, password);
        toast.success("Account created", {
          description: "Check your email to confirm.",
        });
      }
    } catch (err) {
      toast.error(mode === "signin" ? "Sign-in failed" : "Sign-up failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!email) {
      toast.error("Enter your email first");
      return;
    }
    try {
      await resetPassword(email);
      toast.success("Password reset email sent");
    } catch (err) {
      toast.error("Reset failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 py-2">
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
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
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
  );
}
