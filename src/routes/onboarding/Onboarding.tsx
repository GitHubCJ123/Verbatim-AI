/** Resumable onboarding and Quick Start, outside AppShell. */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
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
import { SpeechModelPicker } from "../../components/settings/SpeechModelPicker";
import { CleanupModelPicker } from "../../components/settings/CleanupModelPicker";
import {
  applyOnboarding,
  COMMON_APPS,
  TONE_LABEL,
  useOnboarding,
  type Tone,
} from "../../lib/store/useOnboarding";
import { osName, micPermissionPath } from "../../lib/os";
import {
  applyHotkey,
  hotkeyErrorTitle,
  saveHotkeyConfig,
  loadHotkeyConfig,
  hotkeyDisplayParts,
  DEFAULT_SPEC,
  IS_MAC,
  isForcedHoldSpec,
  usesHoldToTalk,
  needsInputMonitoring,
  getModifierHotkeyStatus,
} from "../../lib/hotkey";
import { cn } from "../../lib/utils";
import { useAuth } from "../../lib/store/useAuth";
import { isLocalMode } from "../../lib/appMode";
import { CLOUD_FEATURES_ENABLED } from "../../lib/features";
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
  ShieldCheck,
  Wand2,
  MessageCircle,
  Smile,
  GraduationCap,
  List,
  Hash,
  Briefcase,
  ClipboardList,
} from "lucide-react";

const TOTAL_STEPS = 13;

const HUE_PER_STEP = [
  "168, 85, 247", // 0 welcome
  "34, 211, 238", // 1 mic
  "52, 211, 153", // 2 sign-in
  "56, 189, 248", // 3 AI model — sky
  "217, 70, 239", // 4 modes — fuchsia
  "251, 191, 36", // 5 hotkey — amber
  "244, 114, 182", // 6 apps pick — pink
  "139, 92, 246", // 7 tones — indigo
  "234, 179, 8", // 8 vocab — yellow
  "59, 130, 246", // 9 history — blue
  "168, 162, 158", // 10 prefs — stone
  "236, 72, 153", // 11 generate — rose
  "16, 185, 129", // 12 done — green
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
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i)
        .filter((i) => CLOUD_FEATURES_ENABLED || i !== 2)
        .map((i) => (
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
    case 0:
      return <Welcome />;
    case 1:
      return <Permissions />;
    case 2:
      return CLOUD_FEATURES_ENABLED ? <SignInStep /> : <AIStep />;
    case 3:
      return <AIStep />;
    case 4:
      return <ModesIntro />;
    case 5:
      return <HotkeyStep />;
    case 6:
      return <AppsPick />;
    case 7:
      return <ToneEach />;
    case 8:
      return <VocabStep />;
    case 9:
      return <HistoryStep />;
    case 10:
      return <PreferencesStep />;
    case 11:
      return <Generate />;
    case 12:
      return <TestRecording />;
    default:
      return null;
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

function prepareQuickStart() {
  const cfg = loadHotkeyConfig();
  const ob = useOnboarding.getState();
  ob.setHotkey(cfg.spec);
  ob.setPushToTalk(usesHoldToTalk(cfg));
}

function Welcome() {
  const next = useOnboarding((s) => s.next);
  const setStep = useOnboarding((s) => s.setStep);
  const finish = useOnboarding((s) => s.finish);
  const navigate = useNavigate();
  const localMode = isLocalMode();

  const quickStart = () => {
    prepareQuickStart();
    setStep(TOTAL_STEPS - 1);
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
        <Button variant="primary" size="lg" onClick={quickStart}>
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
        {localMode
          ? "Quick start checks permissions and helps you choose one local speech model. No account required. Existing models, shortcut, polish and history preferences are kept."
          : "Quick start checks your setup and keeps existing preferences. Everything can be changed later in Settings."}
      </p>
    </div>
  );
}

// ─── Step 2: Permissions ─────────────────────────────────────────────────

function Permissions() {
  const back = useOnboarding((s) => s.back);
  const next = useOnboarding((s) => s.next);
  const setStep = useOnboarding((s) => s.setStep);
  const permission = useOnboarding((s) => s.micPermission);
  return (
    <div>
      <StepHeading
        title="Microphone access"
        subtitle="Allow microphone access when you're ready. Local transcription stays on this computer."
      />
      <PermissionCheck />
      <NavRow
        onBack={back}
        onPrimary={() => (CLOUD_FEATURES_ENABLED ? next() : setStep(3))}
        primaryDisabled={permission !== "granted"}
      />
    </div>
  );
}

function PermissionCheck() {
  const permission = useOnboarding((s) => s.micPermission);
  const setPermission = useOnboarding((s) => s.setMicPermission);
  const [requesting, setRequesting] = useState(false);
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [inputMonitoring, setInputMonitoring] = useState<boolean | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const modifierShortcut = needsInputMonitoring(loadHotkeyConfig().spec);

  useEffect(() => {
    const check = async () => {
      try {
        if (IS_MAC) setAccessibility(await invoke<boolean>("check_accessibility_permission"));
        if (modifierShortcut) {
          const status = await getModifierHotkeyStatus();
          setInputMonitoring(status.inputMonitoringGranted && status.listenerActive);
        }
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (status.state === "prompt") useOnboarding.setState({ micPermission: "unknown" });
        else setPermission(status.state === "granted" ? "granted" : "denied");
        setCheckError(null);
      } catch {
        setCheckError(
          "Permission status couldn't be verified. Use Allow to check the microphone; check system permissions before dictating.",
        );
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [setPermission, modifierShortcut]);

  const request = async () => {
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermission("granted");
      setCheckError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotAllowedError") setPermission("denied");
      else useOnboarding.setState({ micPermission: "unknown" });
      setCheckError(
        `Couldn't access the microphone: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="text-left">
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
                  : "Allow briefly opens the microphone to check access; no audio is saved or transcribed."}
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
      {IS_MAC && (
        <p className="mt-3 text-xs text-text-secondary">
          Accessibility for typing into other apps:{" "}
          {accessibility === null
            ? "not verified"
            : accessibility
              ? "allowed"
              : "needed — enable Verbatim AI in System Settings → Privacy & Security → Accessibility"}
          .
        </p>
      )}
      {modifierShortcut && (
        <p className="mt-2 text-xs text-text-secondary">
          Input Monitoring and shortcut listener:{" "}
          {inputMonitoring === null
            ? "not verified"
            : inputMonitoring
              ? "ready"
              : "setup needed — check the shortcut in Settings → Recording"}
          .
        </p>
      )}
      {checkError && (
        <p role="status" className="mt-2 text-xs text-text-muted">
          {checkError}
        </p>
      )}
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
          subtitle={
            CLOUD_FEATURES_ENABLED
              ? "No account — everything stays on this device."
              : "No account required. Cloud accounts and sync are unavailable in this build."
          }
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
            <div className="text-xs text-text-muted">
              Sign in on another machine to pick up where you left off.
            </div>
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
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // fn / right ⌘ without Input Monitoring yet: keep the choice (it is
      // re-registered on every launch) — the status panel above explains
      // the remaining step. Any other failure means the shortcut is unusable.
      if (!message.includes("needs-input-monitoring")) {
        toast.error(hotkeyErrorTitle(e), { description: message });
        return;
      }
    }
    saveHotkeyConfig({ spec: hotkey, pushToTalk: ptt || isForcedHoldSpec(hotkey) });
    setOverlayPosition(pos);
    next();
  };

  return (
    <div>
      <StepHeading
        title="Pick your shortcut"
        subtitle={
          usesHoldToTalk({ spec: hotkey, pushToTalk: ptt })
            ? "Hold your shortcut to record; release to finish."
            : "Press your shortcut to record; press it again to finish."
        }
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
            <Switch
              checked={ptt || isForcedHoldSpec(hotkey)}
              disabled={isForcedHoldSpec(hotkey)}
              onCheckedChange={setPushToTalk}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-elevated px-4 py-3">
            <div>
              <div className="text-sm font-medium">Recording pill position</div>
              <div className="text-xs text-text-muted">
                Where the little overlay sits while you talk.
              </div>
            </div>
            <Select value={pos} onValueChange={(v) => setPos(v as OverlayPosition)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
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
        Don't see one? Add any app later from Modes → Apps.
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
        <StepHeading
          title="No apps picked"
          subtitle="You can add app rules later from Modes → Apps."
        />
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
    isLocalMode() ? "Saving your settings…" : "Syncing your settings…",
    `Created ${created.modes} mode${created.modes === 1 ? "" : "s"} and ${created.mappings} app rule${created.mappings === 1 ? "" : "s"}`,
  ];

  return (
    <div className="text-center">
      <motion.div
        animate={{ rotate: stage < 3 ? 360 : 0, scale: stage === 3 ? [1, 1.1, 1] : 1 }}
        transition={
          stage < 3 ? { duration: 1.5, repeat: Infinity, ease: "linear" } : { duration: 0.4 }
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
  const cfg = loadHotkeyConfig();
  const hotkeyParts = hotkeyDisplayParts(cfg.spec);
  const [practice, setPractice] = useState("");

  return (
    <div className="text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-pill bg-gradient-to-br from-accent-start to-accent-end shadow-glow">
        <Mic className="h-7 w-7 text-white" strokeWidth={2.25} />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">Your Quick Start checklist</h2>
      <p className="mt-2 text-xs text-text-muted">
        Check permissions and model files before your first dictation. You can finish setup later.
      </p>
      <PermissionCheck />
      <div className="mt-5 text-left">
        <SpeechModelPicker />
      </div>
      <div className="mt-5 text-left">
        <h3 className="text-sm font-medium">AI polish · optional</h3>
        {isAiImproveDisabled() ? (
          <p className="mt-2 text-xs text-text-muted">
            Off — your raw transcript is used. Enable polish later in Settings → AI model.
          </p>
        ) : (
          <div className="mt-2">
            <CleanupModelPicker />
          </div>
        )}
      </div>
      <p className="mt-3 text-sm text-text-secondary">
        {usesHoldToTalk(cfg) ? "Hold" : "Press"}{" "}
        {hotkeyParts.map((k, i) => (
          <span key={k}>
            {i > 0 && " "}
            <Kbd>{k}</Kbd>
          </span>
        ))}{" "}
        {usesHoldToTalk(cfg)
          ? "to record; release to finish."
          : "to record; press again to finish."}{" "}
        When setup is ready, try it with your cursor in a text field on {osName()}.
      </p>
      <div className="mt-5 rounded-lg border border-border-subtle p-4 text-left">
        <label htmlFor="setup-practice" className="text-sm font-medium">
          Practice space
        </label>
        <p className="mb-3 mt-1 text-xs text-text-muted">
          Type synthetic text here, such as “The meeting is at nine.” This field does not run speech
          or AI polish and does not save text.
        </p>
        <Input
          id="setup-practice"
          value={practice}
          onChange={(e) => setPractice(e.target.value)}
          placeholder="The meeting is at nine."
        />
      </div>
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

function AIStep() {
  const back = useOnboarding((s) => s.back);
  const setStep = useOnboarding((s) => s.setStep);
  const [polish, setPolish] = useState(() => !isAiImproveDisabled());

  const togglePolish = (on: boolean) => {
    setAiImproveDisabled(!on);
    setPolish(on);
  };

  return (
    <div>
      <StepHeading
        title="Pick your AI"
        subtitle={
          CLOUD_FEATURES_ENABLED
            ? "Verbatim AI uses two models: one to transcribe your speech, one to polish the text. Both can run in the cloud or fully on this machine."
            : "Verbatim AI uses two models: one to transcribe your speech, one to polish the text. Both run fully on this machine."
        }
      />
      <Card className="mt-6">
        <CardContent className="flex items-start gap-3 p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-solid/15 text-accent-solid">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Privacy:</span>{" "}
            {CLOUD_FEATURES_ENABLED
              ? "Cloud transcription sends audio to the configured service. Choose a local model to transcribe on this computer."
              : "everything runs on your computer, even when you're offline. Your audio never leaves this machine."}
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 text-xs font-medium uppercase tracking-wide text-text-muted">
        Speech model
      </div>
      <div className="mt-2">
        <SpeechModelPicker />
      </div>
      <p className="mt-2 text-[11px] text-text-muted">
        Choose your language for a compatible recommendation. You can download others and switch any
        time in Settings → AI model; your own model files go under Advanced there.
      </p>

      <div className="mt-5 text-xs font-medium uppercase tracking-wide text-text-muted">
        AI polish (optional)
      </div>
      <Card className="mt-2">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-solid/15 text-accent-solid">
              <Wand2 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium">Improve with AI</div>
              <div className="text-xs leading-relaxed text-text-muted">
                A small model on this computer removes fillers, applies self-corrections, writes
                numbers properly and shapes each Mode&apos;s style. Off pastes exactly what you
                said.
              </div>
            </div>
          </div>
          <Switch checked={polish} onCheckedChange={togglePolish} />
        </CardContent>
      </Card>
      {polish && (
        <div className="mt-2">
          <CleanupModelPicker />
          <p className="mt-2 text-[11px] text-text-muted">
            Download one model to start. You can switch any time in Settings → AI model.
          </p>
        </div>
      )}

      <NavRow
        onBack={() => (CLOUD_FEATURES_ENABLED ? back() : setStep(1))}
        onPrimary={() => setStep(4)}
      />
    </div>
  );
}

// ─── Step: Modes intro ───────────────────────────────────────────────────

const DEFAULT_MODES: Array<{ name: string; description: string; Icon: typeof Mail }> = [
  {
    name: "Default",
    description: "Light cleanup — fixes fillers and grammar, preserves tone.",
    Icon: Sparkles,
  },
  {
    name: "Casual",
    description: "Clear, friendly sentences. No formalities.",
    Icon: MessageCircle,
  },
  {
    name: "Very Casual",
    description: "Texting energy — lowercase, minimal punctuation.",
    Icon: Smile,
  },
  {
    name: "Formal",
    description: "Professional prose. Polished but not email-shaped.",
    Icon: GraduationCap,
  },
  { name: "Formal Email", description: "Greeting, body, sign-off — the full shape.", Icon: Mail },
  { name: "Slack Message", description: "Short, casual, optional emoji.", Icon: MessageSquare },
  { name: "Code Comment", description: "Imperative, concise, ~80 char wrap.", Icon: CodeIcon },
  {
    name: "Notes",
    description: "Brain-dump friendly. Bullets where they help.",
    Icon: NotebookPen,
  },
  { name: "Bullet Points", description: "Clean bulleted list, one idea per bullet.", Icon: List },
  { name: "Tweet / X Post", description: "Punchy, under 280 chars, no hashtag spam.", Icon: Hash },
  {
    name: "LinkedIn Post",
    description: "Professional but warm. Short paragraphs.",
    Icon: Briefcase,
  },
  {
    name: "Meeting Note",
    description: "Decisions + action items, stripped of filler.",
    Icon: ClipboardList,
  },
  {
    name: "Translate → English",
    description: "Speak any language, get clean English back.",
    Icon: Languages,
  },
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

  const has = (term: string) => terms.some((t) => t.term.toLowerCase() === term.toLowerCase());

  const addSuggested = async (s: (typeof SUGGESTED_VOCAB)[number]) => {
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
                  {added ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void addDraft()}
              disabled={!draft.term.trim()}
            >
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
      <NavRow onBack={back} onPrimary={next} secondaryLabel="Skip" onSecondary={next} />
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
            Good for finding "that thing I dictated yesterday," reusing common messages, or pasting
            an old transcript into a different app. We never store the raw audio — only the
            cleaned-up text.
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
          <PrefRow Icon={Palette} title="Theme" description="Match your system or pick a side.">
            <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
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
