/**
 * Onboarding flow (plan §15). One file, 8 steps, animated transitions.
 *
 * Routes outside AppShell so it can be full-bleed with a shifting
 * gradient backdrop.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Mic,
  ArrowRight,
  ArrowLeft,
  Check,
  AlertTriangle,
  Sparkles,
  Loader2,
} from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Kbd } from "../../components/ui/Kbd";
import { Switch } from "../../components/ui/Switch";
import { Badge } from "../../components/ui/Badge";
import { Card, CardContent } from "../../components/ui/Card";
import { HotkeyRecorder } from "../../components/settings/HotkeyRecorder";
import {
  applyOnboarding,
  COMMON_APPS,
  TONE_LABEL,
  useOnboarding,
  type Tone,
} from "../../lib/store/useOnboarding";
import { applyHotkey, saveHotkeyConfig } from "../../lib/hotkey";
import { cn } from "../../lib/utils";
import { useAuth } from "../../lib/store/useAuth";
import { toast } from "../../components/ui/Toast";

const TOTAL_STEPS = 8;

const HUE_PER_STEP = [
  ["#1a0f2e", "#0a0a0f"],
  ["#0f1f2e", "#0a0a0f"],
  ["#0f2e2a", "#0a0a0f"],
  ["#2e1f0f", "#0a0a0f"],
  ["#2e0f24", "#0a0a0f"],
  ["#1f0f2e", "#0a0a0f"],
  ["#0f1a2e", "#0a0a0f"],
  ["#0f2e1f", "#0a0a0f"],
];

export default function Onboarding() {
  const step = useOnboarding((s) => s.step);
  const [from, to] = HUE_PER_STEP[step] ?? HUE_PER_STEP[0];

  return (
    <div
      className="relative flex h-screen w-screen flex-col items-center justify-center overflow-hidden text-text-primary transition-colors duration-700"
      style={{ background: `radial-gradient(80% 60% at 50% 0%, ${from}, ${to})` }}
    >
      <ProgressDots />
      <div className="relative flex w-full flex-1 items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="mx-auto w-full max-w-2xl px-8"
          >
            <StepBody step={step} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function ProgressDots() {
  const step = useOnboarding((s) => s.step);
  return (
    <div className="flex items-center gap-1.5 pt-8">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 rounded-pill transition-all duration-300",
            i === step
              ? "w-8 bg-gradient-to-r from-accent-start to-accent-end"
              : i < step
                ? "w-1.5 bg-accent-solid/60"
                : "w-1.5 bg-white/[0.08]",
          )}
        />
      ))}
    </div>
  );
}

function StepBody({ step }: { step: number }) {
  switch (step) {
    case 0: return <Welcome />;
    case 1: return <Permissions />;
    case 2: return <SignInStep />;
    case 3: return <HotkeyStep />;
    case 4: return <AppsPick />;
    case 5: return <ToneEach />;
    case 6: return <Generate />;
    case 7: return <TestRecording />;
    default: return null;
  }
}

function NavRow({
  onBack,
  primaryLabel = "Continue",
  onPrimary,
  primaryDisabled,
  secondaryLabel,
  onSecondary,
}: {
  onBack?: () => void;
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="mt-10 flex items-center justify-between">
      <div>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {secondaryLabel && onSecondary && (
          <Button variant="ghost" size="sm" onClick={onSecondary}>
            {secondaryLabel}
          </Button>
        )}
        {onPrimary && (
          <Button variant="primary" onClick={onPrimary} disabled={primaryDisabled}>
            {primaryLabel}
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Step 1: Welcome ─────────────────────────────────────────────────────

function Welcome() {
  const next = useOnboarding((s) => s.next);
  const finish = useOnboarding((s) => s.finish);
  const navigate = useNavigate();

  return (
    <div className="text-center">
      <motion.div
        animate={{ scale: [1, 1.05, 1] }}
        transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
        className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-lg2 bg-gradient-to-br from-accent-start to-accent-end shadow-glow"
      >
        <Mic className="h-9 w-9 text-white" strokeWidth={2} />
      </motion.div>
      <h1 className="bg-gradient-to-r from-accent-start to-accent-end bg-clip-text text-4xl font-semibold tracking-tight text-transparent">
        SuperWisper
      </h1>
      <p className="mt-3 text-base text-text-secondary">
        Talk anywhere. We type it for you, in your voice, in the right tone, in any app.
      </p>
      <div className="mt-10 flex justify-center gap-3">
        <Button variant="primary" size="lg" onClick={next}>
          Get started
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="lg"
          onClick={() => {
            finish();
            navigate("/", { replace: true });
          }}
        >
          I'm just exploring
        </Button>
      </div>
    </div>
  );
}

// ─── Step 2: Permissions ─────────────────────────────────────────────────

function Permissions() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const permission = useOnboarding((s) => s.micPermission);
  const setPermission = useOnboarding((s) => s.setMicPermission);
  const [requesting, setRequesting] = useState(false);

  const request = async () => {
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermission("granted");
    } catch {
      setPermission("denied");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div>
      <StepHeading
        title="Microphone access"
        subtitle="SuperWisper sends your audio to our cloud just long enough to transcribe and polish it. Recordings themselves are never stored."
      />
      <Card className="mt-8">
        <CardContent className="flex items-center justify-between gap-4 p-6 pt-6">
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-pill",
                permission === "granted"
                  ? "bg-success/20 text-success"
                  : permission === "denied"
                    ? "bg-danger/20 text-danger"
                    : "bg-bg-elevated text-text-secondary",
              )}
            >
              {permission === "granted" ? (
                <Check className="h-4 w-4" strokeWidth={3} />
              ) : permission === "denied" ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </div>
            <div>
              <div className="text-sm font-medium">
                {permission === "granted"
                  ? "Microphone allowed"
                  : permission === "denied"
                    ? "Microphone blocked"
                    : "Microphone not yet granted"}
              </div>
              <div className="text-xs text-text-muted">
                {permission === "denied"
                  ? "Open Windows Settings → Privacy → Microphone to allow access."
                  : "Click below; Windows will ask once."}
              </div>
            </div>
          </div>
          <Button
            variant={permission === "granted" ? "secondary" : "primary"}
            size="sm"
            onClick={request}
            disabled={requesting}
          >
            {requesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {permission === "granted" ? "Re-test" : "Allow"}
          </Button>
        </CardContent>
      </Card>
      <NavRow
        onBack={back}
        onPrimary={next}
        primaryDisabled={permission !== "granted"}
      />
    </div>
  );
}

// ─── Step 3: Sign in (optional) ──────────────────────────────────────────

function SignInStep() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const user = useAuth((s) => s.user);

  return (
    <div>
      <StepHeading
        title="You're signed in"
        subtitle="Your modes, vocabulary, app rules, and transcript history will sync to your account automatically."
      />
      <Card className="mt-8">
        <CardContent className="flex items-center gap-4 p-6 pt-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-pill bg-success/20 text-success">
            <Check className="h-4 w-4" strokeWidth={3} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">{user?.email ?? "Signed in"}</div>
            <div className="text-xs text-text-muted">Sign in on another machine to pick up where you left off.</div>
          </div>
          <Badge variant="success">Synced</Badge>
        </CardContent>
      </Card>
      <NavRow onBack={back} onPrimary={next} primaryLabel="Continue" />
    </div>
  );
}

// ─── Step 4: Hotkey ──────────────────────────────────────────────────────

function HotkeyStep() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const hotkey = useOnboarding((s) => s.hotkey);
  const ptt = useOnboarding((s) => s.pushToTalk);
  const setHotkeyState = useOnboarding((s) => s.setHotkey);
  const setPushToTalk = useOnboarding((s) => s.setPushToTalk);

  const commit = async () => {
    try {
      await applyHotkey(hotkey);
      saveHotkeyConfig({ spec: hotkey, pushToTalk: ptt });
      next();
    } catch (e) {
      toast.error("Couldn't register that shortcut", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div>
      <StepHeading
        title="Pick your shortcut"
        subtitle="Hold this anywhere in Windows to start dictating."
      />
      <Card className="mt-8">
        <CardContent className="flex flex-col gap-5 p-6 pt-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Global hotkey</div>
              <div className="text-xs text-text-muted">Default: <Kbd>Ctrl</Kbd> <Kbd>Space</Kbd></div>
            </div>
            <HotkeyRecorder value={hotkey} onChange={setHotkeyState} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-elevated px-4 py-3">
            <div>
              <div className="text-sm font-medium">Push-to-talk</div>
              <div className="text-xs text-text-muted">Hold to record. Off = tap to toggle.</div>
            </div>
            <Switch checked={ptt} onCheckedChange={setPushToTalk} />
          </div>
        </CardContent>
      </Card>
      <NavRow onBack={back} onPrimary={commit} />
    </div>
  );
}

// ─── Step 5: Pick apps ───────────────────────────────────────────────────

function AppsPick() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const picks = useOnboarding((s) => s.picks);
  const toggle = useOnboarding((s) => s.togglePick);
  const someChosen = useMemo(() => Object.values(picks).some(Boolean), [picks]);

  return (
    <div>
      <StepHeading
        title="Where will you use SuperWisper?"
        subtitle="Pick the apps you use often. We'll tune the tone for each."
      />
      <div className="mt-8 grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {COMMON_APPS.map((a) => {
          const selected = picks[a.exe];
          return (
            <button
              key={a.exe}
              type="button"
              onClick={() => toggle(a.exe)}
              className={cn(
                "flex items-center justify-between rounded-md border px-4 py-3 text-left transition-all",
                selected
                  ? "border-accent-solid/60 bg-accent-solid/10"
                  : "border-border-subtle bg-bg-elevated hover:border-border-strong",
              )}
            >
              <div>
                <div className="text-sm font-medium">{a.displayName}</div>
                <div className="font-mono text-[10px] text-text-muted">{a.exe}</div>
              </div>
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-sm border",
                  selected
                    ? "border-transparent bg-accent-solid text-white"
                    : "border-border-strong",
                )}
              >
                {selected && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>
      <NavRow
        onBack={back}
        onPrimary={next}
        secondaryLabel="Skip"
        onSecondary={next}
        primaryDisabled={!someChosen}
      />
    </div>
  );
}

// ─── Step 6: Tone per app ────────────────────────────────────────────────

function ToneEach() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const picks = useOnboarding((s) => s.picks);
  const tones = useOnboarding((s) => s.tones);
  const setTone = useOnboarding((s) => s.setTone);
  const customTone = useOnboarding((s) => s.customTone);
  const setCustomTone = useOnboarding((s) => s.setCustomTone);

  const chosen = COMMON_APPS.filter((a) => picks[a.exe]);
  const anyCustom = chosen.some((a) => tones[a.exe] === "custom");

  if (chosen.length === 0) {
    return (
      <div>
        <StepHeading title="No apps picked" subtitle="You can add app rules later from the Apps page." />
        <NavRow onBack={back} onPrimary={next} />
      </div>
    );
  }

  return (
    <div>
      <StepHeading
        title="How do you sound in each?"
        subtitle="We'll generate Modes from your tone picks."
      />
      <div className="mt-6 flex max-h-[380px] flex-col gap-2 overflow-y-auto pr-1">
        {chosen.map((a) => (
          <Card key={a.exe}>
            <CardContent className="flex items-center justify-between gap-4 p-3 pl-4">
              <div className="text-sm font-medium">{a.displayName}</div>
              <div className="flex gap-1">
                {(["formal", "casual", "very_casual", "custom"] as Tone[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTone(a.exe, t)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-[11px] transition-all",
                      tones[a.exe] === t
                        ? "border-accent-solid/60 bg-accent-solid/15 text-text-primary"
                        : "border-border-subtle bg-bg-elevated text-text-secondary hover:border-border-strong",
                    )}
                  >
                    {TONE_LABEL[t]}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {anyCustom && (
        <Card className="mt-3">
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="text-xs font-medium text-text-secondary">Describe your custom tone</div>
            <Input
              placeholder="e.g. dry, terse, no emoji ever"
              value={customTone}
              onChange={(e) => setCustomTone(e.target.value)}
            />
          </CardContent>
        </Card>
      )}
      <NavRow onBack={back} onPrimary={next} />
    </div>
  );
}

// ─── Step 7: Generate ────────────────────────────────────────────────────

function Generate() {
  const next = useOnboarding((s) => s.next);
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(0);
  const [created, setCreated] = useState({ modes: 0, mappings: 0 });

  useEffect(() => {
    const steps: Array<[number, () => void | Promise<void>]> = [
      [600, () => setStage(1)],
      [600, () => setStage(2)],
      [
        600,
        async () => {
          try {
            const { modesCreated, mappingsCreated } = await applyOnboarding();
            setCreated({ modes: modesCreated, mappings: mappingsCreated });
          } catch (e) {
            console.warn("[SuperWisper] onboarding apply failed", e);
          }
          setStage(3);
        },
      ],
      [800, () => next()],
    ];
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      const [delay, fn] = steps[i];
      setTimeout(async () => {
        if (cancelled) return;
        await fn();
        i += 1;
        if (i < steps.length) tick();
      }, delay);
    };
    tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const labels = [
    "Creating your Modes…",
    "Mapping your apps…",
    "Syncing your settings…",
    `Created ${created.modes} mode${created.modes === 1 ? "" : "s"} and ${created.mappings} app rule${created.mappings === 1 ? "" : "s"}`,
  ];

  return (
    <div className="text-center">
      <motion.div
        animate={{ rotate: stage < 3 ? 360 : 0, scale: stage === 3 ? [1, 1.1, 1] : 1 }}
        transition={
          stage < 3
            ? { duration: 1.5, repeat: Infinity, ease: "linear" }
            : { duration: 0.4 }
        }
        className="mx-auto mb-8 flex h-16 w-16 items-center justify-center rounded-pill bg-gradient-to-br from-accent-start to-accent-end shadow-glow"
      >
        {stage < 3 ? (
          <Sparkles className="h-7 w-7 text-white" />
        ) : (
          <Check className="h-7 w-7 text-white" strokeWidth={3} />
        )}
      </motion.div>
      <h2 className="text-xl font-semibold">{labels[stage]}</h2>
      <p className="mt-2 text-xs text-text-muted">This won't take long.</p>
    </div>
  );
}

// ─── Step 8: Test recording ──────────────────────────────────────────────

function TestRecording() {
  const navigate = useNavigate();
  const finish = useOnboarding((s) => s.finish);
  const back = useOnboarding((s) => s.back);

  return (
    <div className="text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-pill bg-gradient-to-br from-accent-start to-accent-end shadow-glow">
        <Mic className="h-7 w-7 text-white" strokeWidth={2.25} />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">You're all set</h2>
      <p className="mt-3 text-sm text-text-secondary">
        Hold <Kbd>Ctrl</Kbd> <Kbd>Space</Kbd> anywhere in Windows and say something. The pill will
        appear, your voice will type itself wherever your cursor is.
      </p>
      <p className="mt-2 text-xs text-text-muted">
        Tweak your modes, vocabulary, and per-app tones any time from the sidebar.
      </p>
      <NavRow
        onBack={back}
        primaryLabel="Open SuperWisper"
        onPrimary={() => {
          finish();
          navigate("/", { replace: true });
        }}
      />
    </div>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      {subtitle && <p className="mx-auto mt-2 max-w-md text-sm text-text-secondary">{subtitle}</p>}
    </div>
  );
}
