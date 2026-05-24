import { useEffect, useState } from "react";
import { Mic, Sparkles, Zap, Clock, Square } from "lucide-react";
import { Card, CardContent } from "../components/ui/Card";
import { Kbd } from "../components/ui/Kbd";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { startRecording, stopRecording } from "../lib/recording-bridge";
import { toast } from "../components/ui/Toast";
import { useModes } from "../lib/store/useModes";
import { useAuth } from "../lib/store/useAuth";
import { isHotkeyPaused, setHotkeyPaused } from "../lib/preferences";
import { listTranscriptions, type Transcription } from "../lib/history";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";

export default function Home() {
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(isHotkeyPaused());
  const modes = useModes((s) => s.modes);
  const defaultModeId = useModes((s) => s.defaultModeId);
  const defaultMode = modes.find((m) => m.id === defaultModeId) ?? modes[0];
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const [items, setItems] = useState<Transcription[]>([]);

  useEffect(() => {
    const refresh = () => {
      void listTranscriptions({ limit: 200 })
        .then(setItems)
        .catch(() => {});
    };
    refresh();
    const offResult = listen("recording:result", () => setTimeout(refresh, 400));
    const offReviewed = listen("recording:reviewed", () => setTimeout(refresh, 400));
    return () => {
      void offResult.then((u) => u());
      void offReviewed.then((u) => u());
    };
  }, [user?.id]);

  const stats = computeStats(items);

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
              <button
                type="button"
                onClick={() => {
                  const next = !paused;
                  setHotkeyPaused(next);
                  setPaused(next);
                  toast[next ? "info" : "success"](
                    next ? "Hotkey paused" : "Hotkey resumed",
                  );
                }}
                title={paused ? "Click to resume hotkey" : "Click to pause hotkey"}
                aria-label={paused ? "Resume hotkey" : "Pause hotkey"}
                className="group inline-flex items-center gap-1.5 rounded-full transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-solid/60"
              >
                <Badge variant={paused ? "warning" : "success"}>
                  {paused ? "Paused" : "Active"}
                </Badge>
                <span className="text-xs text-text-muted transition group-hover:text-text-secondary">
                  {paused ? "click to resume" : "click to pause"}
                </span>
              </button>
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
          { label: "Words today", value: stats.wordsToday.toLocaleString(), icon: Sparkles },
          { label: "This week", value: stats.wordsWeek.toLocaleString(), icon: Zap },
          { label: "Time saved", value: formatMinutes(stats.minutesSaved), icon: Clock },
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
        {items.length === 0 ? (
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
        ) : (
          <Card>
            <CardContent className="p-0">
              {items.slice(0, 5).map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate("/history")}
                  className="flex w-full items-center gap-3 border-b border-border-subtle px-5 py-3 text-left transition-colors hover:bg-bg-elevated last:border-b-0"
                >
                  <Badge variant="default" className="shrink-0">
                    {t.mode_name_snap ?? "Default"}
                  </Badge>
                  <div className="min-w-0 flex-1 truncate text-sm text-text-secondary">
                    {t.cleaned_text ?? t.raw_text ?? ""}
                  </div>
                  <div className="shrink-0 text-[10px] tabular-nums text-text-muted">
                    {formatTimestamp(t.created_at)}
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </PageContainer>
  );
}

function wordCount(s: string | null): number {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function computeStats(items: Transcription[]) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = startOfToday - now.getDay() * 86_400_000;
  let wordsToday = 0;
  let wordsWeek = 0;
  let wordsTotal = 0;
  let audioMsTotal = 0;
  for (const t of items) {
    const w = t.word_count ?? wordCount(t.cleaned_text);
    wordsTotal += w;
    audioMsTotal += t.audio_duration_ms ?? 0;
    const at = new Date(t.created_at).getTime();
    if (at >= startOfToday) wordsToday += w;
    if (at >= startOfWeek) wordsWeek += w;
  }
  // Time saved = typing time at 40wpm minus audio recording time.
  const minutesTyping = wordsTotal / 40;
  const minutesAudio = audioMsTotal / 60_000;
  const minutesSaved = Math.max(0, Math.round(minutesTyping - minutesAudio));
  return { wordsToday, wordsWeek, minutesSaved };
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
