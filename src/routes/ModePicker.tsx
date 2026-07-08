/**
 * First-launch entry: pick local mode or cloud (account) mode.
 * Sets `sw.app.mode` and reloads so the boot flow re-evaluates.
 */
import { Cloud, HardDrive } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { setAppMode } from "../lib/appMode";
import { setAiProviderKind, setCleanupProviderKind } from "../lib/ai";
import { setAiImproveDisabled } from "../lib/preferences";

export default function ModePicker() {
  function choose(mode: "local" | "cloud") {
    setAppMode(mode);
    if (mode === "local") {
      setAiProviderKind("local-whisper");
      setCleanupProviderKind("local-ollama");
      setAiImproveDisabled(true);
    }
    window.location.reload();
  }
  return (
    <div
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-bg-base text-text-primary"
      style={{
        backgroundImage:
          "radial-gradient(80% 60% at 50% 0%, rgba(168, 85, 247, 0.18), transparent 70%)",
      }}
    >
      <div className="w-full max-w-2xl px-6">
        <div className="mb-10 text-center">
          <img
            src="/logo.svg"
            alt=""
            className="mx-auto mb-5 h-20 w-20 rounded-lg2 shadow-glow"
          />
          <h1 className="bg-gradient-to-r from-accent-start to-accent-end bg-clip-text text-4xl font-semibold tracking-tight text-transparent">
            Verbatim AI
          </h1>
          <p className="mt-2 text-sm text-text-secondary">How do you want to use it?</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="cursor-pointer transition hover:border-accent-solid/40">
            <CardContent className="flex flex-col gap-3 p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-gradient-to-br from-accent-start to-accent-end">
                <Cloud className="h-5 w-5 text-white" strokeWidth={2} />
              </div>
              <div>
                <div className="text-base font-semibold">Create account</div>
                <div className="mt-1 text-xs text-text-muted">
                  Sync your modes, vocabulary, and transcripts across devices. Sign in
                  with email — magic link or password.
                </div>
              </div>
              <Button variant="primary" size="sm" className="mt-2" onClick={() => choose("cloud")}>
                Continue with account
              </Button>
            </CardContent>
          </Card>
          <Card className="cursor-pointer transition hover:border-accent-solid/40">
            <CardContent className="flex flex-col gap-3 p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-bg-elevated">
                <HardDrive className="h-5 w-5 text-text-primary" strokeWidth={2} />
              </div>
              <div>
                <div className="text-base font-semibold">Use locally</div>
                <div className="mt-1 text-xs text-text-muted">
                  No account. Modes and transcripts stay on this device. You can sign
                  up later and migrate everything.
                </div>
              </div>
              <Button variant="secondary" size="sm" className="mt-2" onClick={() => choose("local")}>
                Continue without account
              </Button>
            </CardContent>
          </Card>
        </div>
        <p className="mt-8 text-center text-xs text-text-muted">
          Local mode starts with on-device transcription and raw transcript output. You can still
          switch any stage to cloud or local cleanup later in Settings → AI model.
        </p>
      </div>
    </div>
  );
}
