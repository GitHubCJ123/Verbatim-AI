import { useState } from "react";
import { Mic, Sparkles, Zap, ChevronRight, Square } from "lucide-react";
import { Card, CardContent } from "../components/ui/Card";
import { Kbd } from "../components/ui/Kbd";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { startRecording, stopRecording } from "../lib/recording-bridge";
import { toast } from "../components/ui/Toast";
import { useModes } from "../lib/store/useModes";

export default function Home() {
  const [active, setActive] = useState(false);
  const modes = useModes((s) => s.modes);
  const defaultModeId = useModes((s) => s.defaultModeId);
  const defaultMode = modes.find((m) => m.id === defaultModeId) ?? modes[0];

  const handleStart = async () => {
    try {
      await startRecording(defaultMode?.name ?? "Default", defaultMode?.id ?? null);
      setActive(true);
    } catch (e) {
      toast.error("Couldn't start recording", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleStop = async () => {
    await stopRecording();
    setActive(false);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Welcome back"
        description="Press your shortcut anywhere in Windows and start talking."
      />

      <Card className="relative overflow-hidden bg-gradient-to-br from-bg-elevated to-transparent">
        <div className="pointer-events-none absolute -top-24 right-0 h-64 w-64 rounded-full bg-accent-solid/20 blur-3xl" />
        <CardContent className="relative flex items-center gap-6 p-8 pt-8">
          <div className="flex h-16 w-16 items-center justify-center rounded-lg2 bg-gradient-to-br from-accent-start to-accent-end shadow-glow">
            <Mic className="h-7 w-7 text-white" strokeWidth={2} />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Hold to dictate</h2>
              <Badge variant="success">Active</Badge>
            </div>
            <p className="text-sm text-text-secondary">
              Press and hold <Kbd>Ctrl</Kbd> <Kbd>Space</Kbd> from any app. Release to transcribe.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {!active ? (
              <Button variant="primary" onClick={handleStart}>
                <Mic className="h-4 w-4" />
                Try it now
              </Button>
            ) : (
              <Button variant="danger" onClick={handleStop}>
                <Square className="h-4 w-4" />
                Stop
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 grid grid-cols-3 gap-4">
        {[
          { label: "Words today", value: "0", icon: Sparkles },
          { label: "This week", value: "0", icon: Zap },
          { label: "Time saved", value: "0m", icon: ChevronRight },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="flex items-center justify-between p-5 pt-5">
              <div>
                <div className="text-xs text-text-muted">{stat.label}</div>
                <div className="mt-1 text-2xl font-semibold tracking-tight">{stat.value}</div>
              </div>
              <stat.icon className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6">
        <h3 className="mb-3 text-sm font-medium text-text-secondary">Recent transcriptions</h3>
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 p-12 pt-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-pill bg-bg-elevated">
              <Mic className="h-4 w-4 text-text-muted" strokeWidth={1.5} />
            </div>
            <div className="text-sm font-medium">No recordings yet</div>
            <div className="text-xs text-text-muted">
              Your transcriptions will appear here once you start dictating.
            </div>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
