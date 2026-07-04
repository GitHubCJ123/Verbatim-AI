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
  Mail,
  MessageSquare,
  Code as CodeIcon,
  NotebookPen,
  Languages,
  History as HistoryIcon,
  Bell,
  Palette,
  Power,
  Plus,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Kbd } from "../../components/ui/Kbd";
import { Switch } from "../../components/ui/Switch";
import { Badge } from "../../components/ui/Badge";
import { Card, CardContent } from "../../components/ui/Card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../components/ui/Select";
import { HotkeyRecorder } from "../../components/settings/HotkeyRecorder";
import {
  applyOnboarding,
  COMMON_APPS,
  TONE_LABEL,
  useOnboarding,
  type Tone,
} from "../../lib/store/useOnboarding";
import { osName, micPermissionPath } from "../../lib/os";
import { applyHotkey, saveHotkeyConfig, loadHotkeyConfig, hotkeyDisplayParts, DEFAULT_SPEC, IS_MAC } from "../../lib/hotkey";
import { cn } from "../../lib/utils";
import { useAuth } from "../../lib/store/useAuth";
import { isLocalMode } from "../../lib/appMode";
import { toast } from "../../components/ui/Toast";
import { useVocabulary } from "../../lib/store/useModes";
import {
  loadOverlayPosition,
  setOverlayPosition,
  type OverlayPosition,
  isHistoryDisabled,
  setHistoryDisabled,
  isAiImproveDisabled,
  setAiImproveDisabled,
  isAutostartEnabled,
  setAutostart,
} from "../../lib/preferences";
import { useTheme, type Theme } from "../../lib/theme";
import {
  getAiProviderKind,
  setAiProviderKind,
  getLocalWhisperTier,
  setLocalWhisperTier,
  listLocalModels,
  downloadLocalModel,
  isWhisperRuntimeInstalled,
  installWhisperRuntime,
  WHISPER_TIERS,
  type AiProviderKind,
  type LocalModelInfo,
  type WhisperTier,
  getCleanupProviderKind,
  setCleanupProviderKind,
  type CleanupProviderKind,
  getOllamaHost,
  setOllamaHost,
  getOllamaModel,
  setOllamaModel,
  listOllamaModels,
  pingOllama,
  type OllamaModelInfo,
  isParakeetRuntimeInstalled,
  installParakeetRuntime,
  listParakeetModels,
  downloadParakeetModel,
  getParakeetVariant,
  setParakeetVariant,
  PARAKEET_VARIANTS,
  type ParakeetVariant,
} from "../../lib/ai";
import { listen } from "@tauri-apps/api/event";
import { Cloud, Cpu, ShieldCheck, Download, CheckCircle2, Wand2, ExternalLink, MessageCircle, Smile, GraduationCap, List, Hash, Briefcase, ClipboardList } from "lucide-react";
import { ProgressBar } from "../../components/ui/ProgressBar";

const TOTAL_STEPS = 13;

const HUE_PER_STEP = [
  "168, 85, 247",   // 0 welcome
  "34, 211, 238",   // 1 mic
  "52, 211, 153",   // 2 sign-in
  "56, 189, 248",   // 3 AI model — sky
  "217, 70, 239",   // 4 modes — fuchsia
  "251, 191, 36",   // 5 hotkey — amber
  "244, 114, 182",  // 6 apps pick — pink
  "139, 92, 246",   // 7 tones — indigo
  "234, 179, 8",    // 8 vocab — yellow
  "59, 130, 246",   // 9 history — blue
  "168, 162, 158",  // 10 prefs — stone
  "236, 72, 153",   // 11 generate — rose
  "16, 185, 129",   // 12 done — green
];

export default function Onboarding() {
  const step = useOnboarding((s) => s.step);
  const tint = HUE_PER_STEP[step] ?? HUE_PER_STEP[0];

  return (
    <div
      className="relative flex h-screen w-screen flex-col items-center justify-center overflow-hidden bg-bg-base text-text-primary transition-colors duration-700"
      style={{
        backgroundImage: `radial-gradient(80% 60% at 50% 0%, rgba(${tint}, 0.18), transparent 70%)`,
      }}
    >
      <ProgressDots />
      <div className="relative flex w-full flex-1 justify-center overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="mx-auto my-auto w-full max-w-3xl px-8 py-10"
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
    case 3: return <AIStep />;
    case 4: return <ModesIntro />;
    case 5: return <HotkeyStep />;
    case 6: return <AppsPick />;
    case 7: return <ToneEach />;
    case 8: return <VocabStep />;
    case 9: return <HistoryStep />;
    case 10: return <PreferencesStep />;
    case 11: return <Generate />;
    case 12: return <TestRecording />;
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

/**
 * Quick-start defaults (docs/improvement-plan/01-quick-setup.md): cloud
 * transcription + cleanup, platform-default hold-to-talk hotkey, history
 * on, pill bottom-center. Built-in Modes are already seeded elsewhere.
 */
async function applyQuickDefaults() {
  const cfg = loadHotkeyConfig(); // platform default unless the user rebound before
  await applyHotkey(cfg.spec);
  saveHotkeyConfig({ spec: cfg.spec, pushToTalk: true });
  setAiProviderKind("cloud");
  setCleanupProviderKind("cloud");
  setAiImproveDisabled(false);
  setHistoryDisabled(false);
  setOverlayPosition("bottom-center");
  const ob = useOnboarding.getState();
  ob.setHotkey(cfg.spec);
  ob.setPushToTalk(true);
}

function Welcome() {
  const next = useOnboarding((s) => s.next);
  const setStep = useOnboarding((s) => s.setStep);
  const finish = useOnboarding((s) => s.finish);
  const navigate = useNavigate();
  const [applying, setApplying] = useState(false);

  const setMicPermission = useOnboarding((s) => s.setMicPermission);

  const quickStart = async () => {
    setApplying(true);
    try {
      // Mic permission is the one step that can't be defaulted.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        setMicPermission("granted");
      } catch {
        setMicPermission("denied");
        setStep(1); // Permissions step has the "how to unblock" guidance
        return;
      }
      await applyQuickDefaults();
      setStep(TOTAL_STEPS - 1); // straight to "You're all set"
    } catch (e) {
      toast.error("Couldn't apply the default setup", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="text-center">
      <motion.img
        src="/logo.svg"
        alt=""
        animate={{ scale: [1, 1.05, 1] }}
        transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
        className="mx-auto mb-8 h-24 w-24 rounded-lg2 shadow-glow"
      />
      <h1 className="bg-gradient-to-r from-accent-start to-accent-end bg-clip-text text-4xl font-semibold tracking-tight text-transparent">
        Verbatim AI
      </h1>
      <p className="mt-3 text-base text-text-secondary">
        Talk anywhere. We type it for you, in your voice, in the right tone, in any app.
      </p>
      <div className="mt-10 flex justify-center gap-3">
        <Button variant="primary" size="lg" onClick={() => void quickStart()} disabled={applying}>
          {applying && <Loader2 className="h-4 w-4 animate-spin" />}
          Quick start
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button variant="secondary" size="lg" onClick={next}>
          Customize setup
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
      <p className="mx-auto mt-6 max-w-md text-xs text-text-muted">
        Quick start uses our defaults: cloud AI (audio is sent to our cloud
        just long enough to transcribe), hold-to-talk hotkey, and transcript
        history on. Everything can be changed later in Settings — including
        switching to fully-local AI.
      </p>
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
        subtitle="Verbatim AI sends your audio to our cloud just long enough to transcribe and polish it. Recordings themselves are never stored."
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
                  ? `Open ${micPermissionPath()} to allow access.`
                  : `Click below; ${osName()} will ask once.`}
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
  const local = isLocalMode();

  if (local) {
    return (
      <div>
        <StepHeading
          title="Local mode"
          subtitle="No account — everything stays on this device. You can sign in later from Account to sync across machines."
        />
        <Card className="mt-8">
          <CardContent className="flex items-center gap-4 p-6 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-pill bg-bg-elevated">
              <Check className="h-4 w-4 text-text-secondary" strokeWidth={3} />
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium">No account</div>
              <div className="text-xs text-text-muted">Data lives in this app only.</div>
            </div>
            <Badge variant="warning">Local</Badge>
          </CardContent>
        </Card>
        <NavRow onBack={back} onPrimary={next} primaryLabel="Continue" />
      </div>
    );
  }

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
  const [pos, setPos] = useState<OverlayPosition>(loadOverlayPosition());

  const commit = async () => {
    try {
      await applyHotkey(hotkey);
      saveHotkeyConfig({ spec: hotkey, pushToTalk: ptt });
      setOverlayPosition(pos);
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
        subtitle={`Hold this anywhere on ${osName()} to start dictating.`}
      />
      <Card className="mt-8">
        <CardContent className="flex flex-col gap-5 p-6 pt-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Global hotkey</div>
              <div className="text-xs text-text-muted">
                Default:{" "}
                {hotkeyDisplayParts(DEFAULT_SPEC).map((k, i) => (
                  <span key={`${k}-${i}`}>
                    {i > 0 && " "}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </div>
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
          <div className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-elevated px-4 py-3">
            <div>
              <div className="text-sm font-medium">Recording pill position</div>
              <div className="text-xs text-text-muted">Where the little overlay sits while you talk.</div>
            </div>
            <Select value={pos} onValueChange={(v) => setPos(v as OverlayPosition)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bottom-center">Bottom center</SelectItem>
                <SelectItem value="top-center">Top center</SelectItem>
                <SelectItem value="bottom-right">Bottom right</SelectItem>
                <SelectItem value="top-right">Top right</SelectItem>
                <SelectItem value="bottom-left">Bottom left</SelectItem>
                <SelectItem value="top-left">Top left</SelectItem>
              </SelectContent>
            </Select>
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
        title="Where will you use Verbatim AI?"
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
      <p className="mt-3 text-center text-xs text-text-muted">
        Don't see one? Add any app later from the Apps page.
      </p>
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
            console.warn("[Verbatim AI] onboarding apply failed", e);
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

const KEY_LABEL: Record<string, string> = IS_MAC
  ? { CommandOrControl: "⌘", Control: "⌃", Shift: "⇧", Alt: "⌥", Super: "⌘" }
  : { CommandOrControl: "Ctrl", Control: "Ctrl", Super: "Win" };

function TestRecording() {
  const navigate = useNavigate();
  const finish = useOnboarding((s) => s.finish);
  const back = useOnboarding((s) => s.back);
  const hotkeyParts = loadHotkeyConfig()
    .spec.split("+")
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-pill bg-gradient-to-br from-accent-start to-accent-end shadow-glow">
        <Mic className="h-7 w-7 text-white" strokeWidth={2.25} />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">You're all set</h2>
      <p className="mt-3 text-sm text-text-secondary">
        Hold{" "}
        {hotkeyParts.map((k, i) => (
          <span key={k}>
            {i > 0 && " "}
            <Kbd>{KEY_LABEL[k] ?? k}</Kbd>
          </span>
        ))}{" "}
        anywhere on {osName()} and say something. The pill will
        appear, your voice will type itself wherever your cursor is.
      </p>
      <p className="mt-2 text-xs text-text-muted">
        Tweak your modes, vocabulary, and per-app tones any time from the sidebar.
      </p>
      <NavRow
        onBack={back}
        primaryLabel="Open Verbatim AI"
        onPrimary={() => {
          finish();
          navigate("/", { replace: true });
        }}
      />
    </div>
  );
}

// ─── Step: AI model ──────────────────────────────────────────────────────

interface ProviderOption {
  kind: AiProviderKind;
  title: string;
  subtitle: string;
  Icon: typeof Cloud;
  bullets: string[];
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    kind: "cloud",
    title: "Cloud (recommended)",
    subtitle: "Azure Whisper · zero setup",
    Icon: Cloud,
    bullets: [
      "Fast, accurate, no download",
      "Audio is processed then immediately discarded",
      "Needs internet",
    ],
  },
  {
    kind: "local-whisper",
    title: "Local Whisper",
    subtitle: "On-device · whisper.cpp",
    Icon: Cpu,
    bullets: [
      "Audio never leaves your machine",
      "Works fully offline once downloaded",
      "Quality scales with model size and your CPU/GPU",
    ],
  },
  {
    kind: "local-parakeet",
    title: "Parakeet TDT",
    subtitle: "On-device · NVIDIA",
    Icon: Cpu,
    bullets: [
      "Audio never leaves your machine",
      "Pick v2 (English) or v3 (25 European languages)",
      "Runs on CPU — no GPU required",
    ],
  },
];

type CleanupChoice = CleanupProviderKind | "none";

function AIStep() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const [kind, setKind] = useState<AiProviderKind>(getAiProviderKind());
  const [cleanup, setCleanup] = useState<CleanupChoice>(() =>
    isAiImproveDisabled() ? "none" : getCleanupProviderKind(),
  );

  const choose = (k: AiProviderKind) => {
    setAiProviderKind(k);
    setKind(k);
  };

  const chooseCleanup = (k: CleanupChoice) => {
    if (k === "none") {
      setAiImproveDisabled(true);
    } else {
      setAiImproveDisabled(false);
      setCleanupProviderKind(k);
    }
    setCleanup(k);
  };

  return (
    <div>
      <StepHeading
        title="Pick your AI"
        subtitle="Verbatim AI uses two models: one to transcribe your speech, one to polish the text. Both can run in the cloud or fully on this machine."
      />
      <Card className="mt-6">
        <CardContent className="flex items-start gap-3 p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-solid/15 text-accent-solid">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Privacy:</span> cloud
            mode sends audio to our Azure endpoint just long enough to transcribe
            — we never store the raw recording. Local mode keeps everything on
            your computer, even when you're offline.
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 text-xs font-medium uppercase tracking-wide text-text-muted">
        Transcription
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {PROVIDER_OPTIONS.map((opt) => {
          const selected = kind === opt.kind;
          return (
            <button
              key={opt.kind}
              type="button"
              onClick={() => choose(opt.kind)}
              className={cn(
                "flex items-start gap-3 rounded-md border px-4 py-3 text-left transition-all",
                selected
                  ? "border-accent-solid/60 bg-accent-solid/10"
                  : "border-border-subtle bg-bg-elevated hover:border-border-strong",
              )}
            >
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                  selected ? "bg-accent-solid/20 text-accent-solid" : "bg-bg-base text-text-secondary",
                )}
              >
                <opt.Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium">{opt.title}</div>
                  <div className="text-[11px] text-text-muted">{opt.subtitle}</div>
                </div>
                <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-text-muted">
                  {opt.bullets.map((b) => (
                    <li key={b}>• {b}</li>
                  ))}
                </ul>
              </div>
              <span
                className={cn(
                  "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-pill border",
                  selected ? "border-transparent bg-accent-solid text-white" : "border-border-strong",
                )}
              >
                {selected && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>

      {kind === "local-whisper" && <LocalWhisperInstaller />}
      {kind === "local-parakeet" && <LocalParakeetInstaller />}

      <div className="mt-5 text-xs font-medium uppercase tracking-wide text-text-muted">
        Cleanup (tone polish)
      </div>
      <Card className="mt-2">
        <CardContent className="flex items-start gap-3 p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-solid/15 text-accent-solid">
            <Wand2 className="h-4 w-4" />
          </span>
          <div className="text-xs leading-relaxed text-text-secondary">
            After transcription, a language model rewrites the raw text using
            the active Mode — fixing grammar, removing fillers, and shaping the
            tone. Cloud uses Azure GPT and is fastest. Local uses your own
            Ollama install so the polish step also stays on your machine.
          </div>
        </CardContent>
      </Card>
      <Card className="mt-2">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">Where polish runs</div>
            <div className="text-xs text-text-muted">
              {cleanup === "cloud"
                ? "Azure GPT — fastest, no setup."
                : cleanup === "local-ollama"
                  ? "Local Ollama on this machine."
                  : "No AI polish — you get the raw transcript as spoken."}
            </div>
          </div>
          <Select value={cleanup} onValueChange={(v) => chooseCleanup(v as CleanupChoice)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cloud">Cloud (Azure)</SelectItem>
              <SelectItem value="local-ollama">Local Ollama</SelectItem>
              <SelectItem value="none">None — raw text</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {cleanup === "local-ollama" && <OllamaConfig />}

      <NavRow onBack={back} onPrimary={next} />
    </div>
  );
}

function OllamaConfig() {
  const [host, setHost] = useState(getOllamaHost());
  const [model, setModel] = useState(getOllamaModel());
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [status, setStatus] = useState<"idle" | "ok" | "unreachable" | "forbidden" | "http-error">("idle");
  const [checking, setChecking] = useState(false);

  const check = async (h: string) => {
    setChecking(true);
    const ping = await pingOllama(h);
    setStatus(ping.kind === "ok" ? "ok" : ping.kind);
    if (ping.kind === "ok") {
      try {
        const m = await listOllamaModels(h);
        setModels(m);
        if (!model && m.length > 0) {
          setModel(m[0].name);
          setOllamaModel(m[0].name);
        }
      } catch {
        /* ignore */
      }
    } else {
      setModels([]);
    }
    setChecking(false);
  };

  useEffect(() => {
    void check(host);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitHost = (v: string) => {
    setHost(v);
    setOllamaHost(v);
  };

  const commitModel = (v: string) => {
    setModel(v);
    setOllamaModel(v);
  };

  return (
    <Card className="mt-2">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Ollama setup</div>
            <div className="text-xs text-text-muted">
              Install Ollama from ollama.com, then{" "}
              <span className="font-mono text-text-secondary">ollama pull qwen3.5:4b</span>{" "}
              (or any other model).
            </div>
          </div>
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent-solid hover:underline"
          >
            ollama.com <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={host}
            onChange={(e) => commitHost(e.target.value)}
            placeholder="http://localhost:11434"
            className="font-mono text-xs"
          />
          <Button variant="secondary" size="sm" onClick={() => void check(host)} disabled={checking}>
            {checking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Test
          </Button>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-elevated px-3 py-2">
          <div className="text-xs">
            {status === "ok" && (
              <span className="inline-flex items-center gap-1 text-success">
                <CheckCircle2 className="h-3.5 w-3.5" /> Reachable · {models.length} model{models.length === 1 ? "" : "s"} installed
              </span>
            )}
            {status === "unreachable" && (
              <span className="inline-flex items-center gap-1 text-danger">
                <AlertTriangle className="h-3.5 w-3.5" /> Can't reach Ollama — is it running? Troubleshoot in Settings → AI.
              </span>
            )}
            {status === "forbidden" && (
              <span className="inline-flex items-center gap-1 text-danger">
                <AlertTriangle className="h-3.5 w-3.5" /> Ollama rejected the origin (allow tauri://localhost). Fix steps in Settings → AI model.
              </span>
            )}
            {status === "http-error" && (
              <span className="inline-flex items-center gap-1 text-danger">
                <AlertTriangle className="h-3.5 w-3.5" /> Ollama responded with an error. Check details in Settings → AI.
              </span>
            )}
            {status === "idle" && <span className="text-text-muted">Checking…</span>}
          </div>
        </div>

        {models.length > 0 ? (
          <div>
            <div className="mb-1 text-xs font-medium text-text-secondary">Model</div>
            <Select value={model} onValueChange={commitModel}>
              <SelectTrigger><SelectValue placeholder="Pick an installed model" /></SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.name} value={m.name}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : status === "ok" ? (
          <div className="rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-xs text-text-muted">
            No models installed yet. In a terminal:{" "}
            <span className="font-mono text-text-secondary">ollama pull qwen3.5:4b</span>
          </div>
        ) : null}

        <div className="text-[11px] text-text-muted">
          You can pull more models and tweak prompts later from Settings → AI.
        </div>
      </CardContent>
    </Card>
  );
}

function LocalWhisperInstaller() {
  const [tier, setTier] = useState<WhisperTier>(getLocalWhisperTier());
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [runtimeInstalled, setRuntimeInstalled] = useState(false);
  const [rtProgress, setRtProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [dlProgress, setDlProgress] = useState<{ downloaded: number; total: number } | null>(null);

  const refresh = async () => {
    try {
      const [m, rt] = await Promise.all([listLocalModels(), isWhisperRuntimeInstalled()]);
      setModels(m);
      setRuntimeInstalled(rt);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refresh();
    const offRtP = listen<{ downloaded: number; total: number }>(
      "local-whisper:runtime:progress",
      (e) => setRtProgress(e.payload),
    );
    const offRtD = listen<string>("local-whisper:runtime:complete", () => {
      setRtProgress(null);
      void refresh();
    });
    const offDlP = listen<{ tier: WhisperTier; downloaded: number; total: number }>(
      "local-whisper:download:progress",
      (e) => {
        if (e.payload.tier === tier) {
          setDlProgress({ downloaded: e.payload.downloaded, total: e.payload.total });
        }
      },
    );
    const offDlD = listen<string>("local-whisper:download:complete", () => {
      setDlProgress(null);
      void refresh();
    });
    return () => {
      void offRtP.then((f) => f());
      void offRtD.then((f) => f());
      void offDlP.then((f) => f());
      void offDlD.then((f) => f());
    };
  }, [tier]);

  const installed = !!models.find((m) => m.tier === tier)?.installed;

  const installRuntime = async () => {
    setRtProgress({ downloaded: 0, total: 0 });
    try {
      await installWhisperRuntime();
      toast.success("Runtime installed");
    } catch (e) {
      toast.error("Couldn't install runtime", { description: e instanceof Error ? e.message : String(e) });
      setRtProgress(null);
    }
  };

  const downloadModel = async () => {
    setDlProgress({ downloaded: 0, total: 0 });
    try {
      await downloadLocalModel(tier);
      toast.success(`Downloaded ${tier}`);
    } catch (e) {
      toast.error("Download failed", { description: e instanceof Error ? e.message : String(e) });
      setDlProgress(null);
    }
  };

  const pickTier = (t: WhisperTier) => {
    setLocalWhisperTier(t);
    setTier(t);
  };

  return (
    <Card className="mt-3">
      <CardContent className="flex flex-col gap-4 p-4">
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">whisper.cpp runtime</div>
              <div className="text-xs text-text-muted">
                Tiny native binary (~5 MB) that runs the model on your hardware.
              </div>
            </div>
            {runtimeInstalled ? (
              <Badge variant="success" className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Installed
              </Badge>
            ) : rtProgress ? (
              <Button variant="secondary" size="sm" disabled>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {rtProgress.total > 0 ? `${Math.round((rtProgress.downloaded / rtProgress.total) * 100)}%` : "Starting…"}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => void installRuntime()}>
                <Download className="h-3.5 w-3.5" /> Install
              </Button>
            )}
          </div>
          {rtProgress && rtProgress.total > 0 && (
            <div className="pt-2">
              <ProgressBar value={Math.round((rtProgress.downloaded / rtProgress.total) * 100)} />
            </div>
          )}
        </div>

        <div className="border-t border-border-subtle pt-3">
          <div className="text-sm font-medium">Model</div>
          <div className="text-xs text-text-muted">Bigger = more accurate, slower. Download once, use forever.</div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {WHISPER_TIERS.map((meta) => {
              const isInstalled = !!models.find((m) => m.tier === meta.tier)?.installed;
              const selected = tier === meta.tier;
              return (
                <button
                  key={meta.tier}
                  type="button"
                  onClick={() => pickTier(meta.tier)}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-3 py-2 text-left text-xs transition-all",
                    selected
                      ? "border-accent-solid/60 bg-accent-solid/10"
                      : "border-border-subtle bg-bg-elevated hover:border-border-strong",
                  )}
                >
                  <div>
                    <div className="text-[12px] font-medium">{meta.label}</div>
                    <div className="text-[10px] text-text-muted">
                      {meta.approxSizeMB >= 1024
                        ? `${(meta.approxSizeMB / 1024).toFixed(1)} GB`
                        : `${meta.approxSizeMB} MB`}
                    </div>
                  </div>
                  {isInstalled && <Check className="h-3 w-3 text-success" strokeWidth={3} />}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-elevated px-3 py-2">
            <div className="min-w-0 text-xs">
              <div className="font-medium">{WHISPER_TIERS.find((t) => t.tier === tier)?.blurb}</div>
              <div className="text-text-muted">Best for: {WHISPER_TIERS.find((t) => t.tier === tier)?.recommendedFor}</div>
            </div>
            {installed ? (
              <Badge variant="success" className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Ready
              </Badge>
            ) : dlProgress ? (
              <Button variant="secondary" size="sm" disabled>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {dlProgress.total > 0 ? `${Math.round((dlProgress.downloaded / dlProgress.total) * 100)}%` : "Starting…"}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => void downloadModel()} disabled={!runtimeInstalled}>
                <Download className="h-3.5 w-3.5" /> Download
              </Button>
            )}
          </div>
          {dlProgress && dlProgress.total > 0 && (
            <div className="pt-2">
              <ProgressBar value={Math.round((dlProgress.downloaded / dlProgress.total) * 100)} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LocalParakeetInstaller() {
  const [runtimeInstalled, setRuntimeInstalled] = useState(false);
  const [models, setModels] = useState<Array<{ variant: ParakeetVariant; installed: boolean }>>([]);
  const [variant, setVariantState] = useState<ParakeetVariant>(getParakeetVariant());
  const [rtProgress, setRtProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [dlProgress, setDlProgress] = useState<{ downloaded: number; total: number } | null>(null);

  const refresh = async () => {
    try {
      const [rt, m] = await Promise.all([
        isParakeetRuntimeInstalled(),
        listParakeetModels(),
      ]);
      setRuntimeInstalled(rt);
      setModels(m.map((x) => ({ variant: x.variant, installed: x.installed })));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refresh();
    const offRtP = listen<{ downloaded: number; total: number }>(
      "parakeet:runtime:progress",
      (e) => setRtProgress(e.payload),
    );
    const offRtD = listen<string>("parakeet:runtime:complete", () => {
      setRtProgress(null);
      void refresh();
    });
    const offDlP = listen<{ downloaded: number; total: number }>(
      "parakeet:download:progress",
      (e) => setDlProgress(e.payload),
    );
    const offDlD = listen<string>("parakeet:download:complete", () => {
      setDlProgress(null);
      void refresh();
    });
    return () => {
      void offRtP.then((f) => f());
      void offRtD.then((f) => f());
      void offDlP.then((f) => f());
      void offDlD.then((f) => f());
    };
  }, []);

  const installRuntime = async () => {
    setRtProgress({ downloaded: 0, total: 0 });
    try {
      await installParakeetRuntime();
      toast.success("Sherpa-onnx runtime installed");
    } catch (e) {
      toast.error("Couldn't install runtime", { description: e instanceof Error ? e.message : String(e) });
      setRtProgress(null);
    }
  };

  const changeVariant = (v: ParakeetVariant) => {
    setParakeetVariant(v);
    setVariantState(v);
  };

  const downloadModel = async () => {
    setDlProgress({ downloaded: 0, total: 0 });
    try {
      await downloadParakeetModel(variant);
      toast.success(`Parakeet ${variant} model downloaded`);
    } catch (e) {
      toast.error("Download failed", { description: e instanceof Error ? e.message : String(e) });
      setDlProgress(null);
    }
  };

  const selectedMeta = PARAKEET_VARIANTS.find((v) => v.variant === variant);
  const modelInstalled = !!models.find((m) => m.variant === variant)?.installed;

  return (
    <Card className="mt-3">
      <CardContent className="flex flex-col gap-3 p-4">
        <InstallRow
          title="Sherpa-onnx runtime"
          subtitle="Native binary that runs Parakeet on your machine (~50 MB, CPU)."
          installed={runtimeInstalled}
          progress={rtProgress}
          onInstall={installRuntime}
        />
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Model variant</div>
          <div className="flex gap-2">
            {PARAKEET_VARIANTS.map((meta) => {
              const isActive = variant === meta.variant;
              return (
                <button
                  key={meta.variant}
                  type="button"
                  onClick={() => changeVariant(meta.variant)}
                  className={`flex-1 rounded-md border p-2 text-left text-xs transition ${
                    isActive
                      ? "border-accent bg-accent/5"
                      : "border-border-subtle hover:border-border"
                  }`}
                >
                  <div className="text-sm font-medium">{meta.label}</div>
                  <div className="text-text-muted">{meta.blurb}</div>
                </button>
              );
            })}
          </div>
        </div>
        <InstallRow
          title={`Parakeet ${variant} model`}
          subtitle={`~${selectedMeta?.approxSizeMB ?? 640} MB · ${selectedMeta?.recommendedFor ?? ""}`}
          installed={modelInstalled}
          progress={dlProgress}
          onInstall={downloadModel}
          disabled={!runtimeInstalled}
        />
      </CardContent>
    </Card>
  );
}

function InstallRow({
  title,
  subtitle,
  installed,
  progress,
  onInstall,
  disabled,
}: {
  title: string;
  subtitle: string;
  installed: boolean;
  progress: { downloaded: number; total: number } | null;
  onInstall: () => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-text-muted">{subtitle}</div>
        </div>
        {installed ? (
          <Badge variant="success" className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> Installed
          </Badge>
        ) : progress ? (
          <Button variant="secondary" size="sm" disabled>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress.total > 0 ? `${Math.round((progress.downloaded / progress.total) * 100)}%` : "Starting…"}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onInstall} disabled={disabled}>
            <Download className="h-3.5 w-3.5" /> Install
          </Button>
        )}
      </div>
      {progress && progress.total > 0 && (
        <div className="pt-2">
          <ProgressBar value={Math.round((progress.downloaded / progress.total) * 100)} />
        </div>
      )}
    </div>
  );
}

// ─── Step: Modes intro ───────────────────────────────────────────────────

const DEFAULT_MODES: Array<{ name: string; description: string; Icon: typeof Mail }> = [
  { name: "Default", description: "Light cleanup — fixes fillers and grammar, preserves tone.", Icon: Sparkles },
  { name: "Casual", description: "Clear, friendly sentences. No formalities.", Icon: MessageCircle },
  { name: "Very Casual", description: "Texting energy — lowercase, minimal punctuation.", Icon: Smile },
  { name: "Formal", description: "Professional prose. Polished but not email-shaped.", Icon: GraduationCap },
  { name: "Formal Email", description: "Greeting, body, sign-off — the full shape.", Icon: Mail },
  { name: "Slack Message", description: "Short, casual, optional emoji.", Icon: MessageSquare },
  { name: "Code Comment", description: "Imperative, concise, ~80 char wrap.", Icon: CodeIcon },
  { name: "Notes", description: "Brain-dump friendly. Bullets where they help.", Icon: NotebookPen },
  { name: "Bullet Points", description: "Clean bulleted list, one idea per bullet.", Icon: List },
  { name: "Tweet / X Post", description: "Punchy, under 280 chars, no hashtag spam.", Icon: Hash },
  { name: "LinkedIn Post", description: "Professional but warm. Short paragraphs.", Icon: Briefcase },
  { name: "Meeting Note", description: "Decisions + action items, stripped of filler.", Icon: ClipboardList },
  { name: "Translate → English", description: "Speak any language, get clean English back.", Icon: Languages },
];

function ModesIntro() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  return (
    <div>
      <StepHeading
        title="Meet Modes"
        subtitle="A Mode is a recipe for turning your raw speech into polished text. Pick one and Verbatim AI rewrites in that style — formal, casual, code, notes, anything."
      />
      <div className="mt-6 grid max-h-[380px] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {DEFAULT_MODES.map(({ name, description, Icon }) => (
          <div
            key={name}
            className="flex items-start gap-3 rounded-md border border-border-subtle bg-bg-elevated px-3 py-3"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-solid/15 text-accent-solid">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium">{name}</div>
              <div className="text-xs text-text-muted">{description}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-center text-xs text-text-muted">
        You can edit these or build your own from the Modes page later.
      </p>
      <NavRow onBack={back} onPrimary={next} />
    </div>
  );
}

// ─── Step: Vocabulary ────────────────────────────────────────────────────

const SUGGESTED_VOCAB: Array<{ term: string; replacement: string | null; notes: string }> = [
  { term: "verbatim", replacement: "Verbatim AI", notes: "Product name" },
  { term: "github", replacement: "GitHub", notes: "Casing" },
  { term: "ios", replacement: "iOS", notes: "Casing" },
  { term: "api", replacement: "API", notes: "Acronym" },
  { term: "Kubernetes", replacement: null, notes: "Spelling only" },
];

function VocabStep() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const terms = useVocabulary((s) => s.terms);
  const add = useVocabulary((s) => s.add);
  const remove = useVocabulary((s) => s.remove);
  const [draft, setDraft] = useState({ term: "", replacement: "" });

  const has = (term: string) =>
    terms.some((t) => t.term.toLowerCase() === term.toLowerCase());

  const addSuggested = async (s: typeof SUGGESTED_VOCAB[number]) => {
    if (has(s.term)) return;
    await add({ term: s.term, replacement: s.replacement, notes: s.notes });
  };

  const addDraft = async () => {
    const t = draft.term.trim();
    if (!t) return;
    await add({ term: t, replacement: draft.replacement.trim() || null });
    setDraft({ term: "", replacement: "" });
  };

  return (
    <div>
      <StepHeading
        title="Vocabulary"
        subtitle="Teach Verbatim AI words it keeps mishearing or words you want spelled a specific way — names, acronyms, brands. Leave the replacement blank to just lock in the spelling."
      />
      <Card className="mt-6">
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="text-xs font-medium text-text-secondary">Quick adds</div>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_VOCAB.map((s) => {
              const added = has(s.term);
              return (
                <button
                  key={s.term}
                  type="button"
                  onClick={() => void addSuggested(s)}
                  disabled={added}
                  className={cn(
                    "flex items-center gap-1.5 rounded-pill border px-3 py-1 text-xs transition-all",
                    added
                      ? "border-success/50 bg-success/10 text-success"
                      : "border-border-subtle bg-bg-elevated text-text-secondary hover:border-accent-solid/60 hover:text-text-primary",
                  )}
                >
                  {added ? <Check className="h-3 w-3" strokeWidth={3} /> : <Plus className="h-3 w-3" />}
                  <span className="font-mono">{s.term}</span>
                  {s.replacement ? (
                    <>
                      <span className="text-text-muted">→</span>
                      <span className="font-mono">{s.replacement}</span>
                    </>
                  ) : (
                    <span className="text-text-muted">(spelling)</span>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <Card className="mt-3">
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="text-xs font-medium text-text-secondary">Add your own</div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Heard as…"
              value={draft.term}
              onChange={(e) => setDraft((d) => ({ ...d, term: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && void addDraft()}
            />
            <span className="text-text-muted">→</span>
            <Input
              placeholder="Replace with… (optional)"
              value={draft.replacement}
              onChange={(e) => setDraft((d) => ({ ...d, replacement: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && void addDraft()}
            />
            <Button variant="secondary" size="sm" onClick={() => void addDraft()} disabled={!draft.term.trim()}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
          {terms.length > 0 && (
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto pt-1">
              {terms.map((t) => (
                <span
                  key={t.id}
                  className="flex items-center gap-1 rounded-pill border border-border-subtle bg-bg-elevated px-2 py-0.5 text-[11px]"
                >
                  <span className="font-mono">{t.term}</span>
                  {t.replacement && (
                    <>
                      <span className="text-text-muted">→</span>
                      <span className="font-mono">{t.replacement}</span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(t.id)}
                    className="ml-0.5 text-text-muted hover:text-danger"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <NavRow
        onBack={back}
        onPrimary={next}
        secondaryLabel="Skip"
        onSecondary={next}
      />
    </div>
  );
}

// ─── Step: History ───────────────────────────────────────────────────────

function HistoryStep() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const [save, setSave] = useState(!isHistoryDisabled());

  useEffect(() => {
    setHistoryDisabled(!save);
  }, [save]);

  return (
    <div>
      <StepHeading
        title="Transcript history"
        subtitle="Every dictation is kept on the History page. Search past transcripts, copy them again, or re-run them through a different Mode."
      />
      <Card className="mt-6">
        <CardContent className="flex items-start gap-3 p-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-solid/15 text-accent-solid">
            <HistoryIcon className="h-4 w-4" />
          </span>
          <div className="text-xs leading-relaxed text-text-secondary">
            Good for finding "that thing I dictated yesterday," reusing common
            messages, or pasting an old transcript into a different app. We
            never store the raw audio — only the cleaned-up text.
          </div>
        </CardContent>
      </Card>
      <Card className="mt-3">
        <CardContent className="flex items-center justify-between p-5">
          <div>
            <div className="text-sm font-medium">Save transcript history</div>
            <div className="text-xs text-text-muted">
              Off = nothing is stored. You'll still see the result once, then it's gone.
            </div>
          </div>
          <Switch checked={save} onCheckedChange={setSave} />
        </CardContent>
      </Card>
      <NavRow onBack={back} onPrimary={next} />
    </div>
  );
}

// ─── Step: Preferences ──────────────────────────────────────────────────

function PreferencesStep() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.set);
  const [autostart, setAutostartState] = useState(false);

  useEffect(() => {
    void isAutostartEnabled().then(setAutostartState);
  }, []);

  const toggleAutostart = async (v: boolean) => {
    try {
      await setAutostart(v);
      setAutostartState(v);
    } catch (e) {
      toast.error("Couldn't change startup setting", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div>
      <StepHeading
        title="A few preferences"
        subtitle="You can change all of these later from Settings."
      />
      <Card className="mt-6">
        <CardContent className="flex flex-col gap-1 p-2">
          <PrefRow
            Icon={Power}
            title="Launch at startup"
            description={`Open Verbatim AI when ${osName()} boots so the hotkey is always live.`}
          >
            <Switch checked={autostart} onCheckedChange={(v) => void toggleAutostart(v)} />
          </PrefRow>
          <PrefRow
            Icon={Palette}
            title="Theme"
            description="Match your system or pick a side."
          >
            <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="system">Match system</SelectItem>
              </SelectContent>
            </Select>
          </PrefRow>
        </CardContent>
      </Card>
      <NavRow onBack={back} onPrimary={next} />
    </div>
  );
}

function PrefRow({
  Icon,
  title,
  description,
  children,
}: {
  Icon: typeof Bell;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-border-subtle px-3 py-3 last:border-b-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-elevated text-text-secondary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
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
