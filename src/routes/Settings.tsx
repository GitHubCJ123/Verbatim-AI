import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { Download, Trash2, CheckCircle2, Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { toast } from "../components/ui/Toast";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/Tabs";
import { Card, CardContent } from "../components/ui/Card";
import { Switch } from "../components/ui/Switch";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ProgressBar } from "../components/ui/ProgressBar";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../components/ui/Select";
import { HotkeyRecorder } from "../components/settings/HotkeyRecorder";
import { applyHotkey, isForcedHoldSpec, loadHotkeyConfig, saveHotkeyConfig } from "../lib/hotkey";
import { handleInputMonitoringError } from "../components/settings/inputMonitoring";
import {
  isAutostartEnabled,
  setAutostart,
  type RecordingEngine,
  getRecordingEngine,
  setRecordingEngine,
} from "../lib/preferences";
import { syncNativeCaptureArm } from "../lib/nativeAudio";
import { CLOUD_FEATURES_ENABLED } from "../lib/features";
import { useOnboarding } from "../lib/store/useOnboarding";
import {
  testTranscriptionProvider,
  testCleanupProvider,
  getAiProviderKind,
  setAiProviderKind,
  getLocalWhisperTier,
  setLocalWhisperTier,
  listLocalModels,
  listCustomWhisperModels,
  rescanLocalModels,
  downloadLocalModel,
  deleteLocalModel,
  isWhisperRuntimeInstalled,
  installWhisperRuntime,
  getWhisperComputePreference,
  setWhisperComputePreference,
  getActiveWhisperRuntimeVariant,
  whisperComputePreferenceLabel,
  whisperRuntimeVariantLabel,
  WHISPER_TIERS,
  type AiProviderKind,
  type CustomModelInfo,
  type LocalModelInfo,
  type WhisperComputePreference,
  type WhisperModelId,
  type WhisperRuntimeVariant,
  type WhisperTier,
  getCleanupProviderKind,
  setCleanupProviderKind,
  getOllamaHost,
  setOllamaHost,
  getOllamaModel,
  setOllamaModel,
  listOllamaModels,
  pingOllama,
  pullOllamaModel,
  SUGGESTED_OLLAMA_MODELS,
  LLAMA_CPP_MODELS,
  getLlamaCppModel,
  setLlamaCppModel,
  isLlamaCppRuntimeInstalled,
  installLlamaCppRuntime,
  type CleanupProviderKind,
  type OllamaModelInfo,
  type PingResult,
  PARAKEET_LANGUAGES,
  getParakeetLanguage,
  setParakeetLanguage,
  PARAKEET_VARIANTS,
  getParakeetVariant,
  setParakeetVariant,
  type ParakeetVariant,
  type ParakeetModelInfo,
  isParakeetRuntimeInstalled,
  installParakeetRuntime,
  listParakeetModels,
  downloadParakeetModel,
  deleteParakeetModel,
} from "../lib/ai";
import { providerTestStatus, type ProviderTestStatus } from "../lib/ai/healthStatus";
import { useTheme, type Theme } from "../lib/theme";
import { osKind, osName } from "../lib/os";
import {
  checkForUpdate,
  getUpdateStatus,
  installAndRelaunch,
  subscribeUpdateStatus,
  type UpdateStatus,
} from "../lib/updater";
import {
  loadOverlayPosition,
  setOverlayPosition,
  type OverlayPosition,
  getOutputBehavior,
  setOutputBehavior,
  type OutputBehavior,
  getPasteMethod,
  setPasteMethod,
  type PasteMethod,
  isHistoryDisabled,
  setHistoryDisabled,
  getHistoryRetentionDays,
  setHistoryRetentionDays,
  type HistoryRetentionDays,
  getMicDeviceId,
  setMicDeviceId,
  isAiImproveDisabled,
  setAiImproveDisabled,
} from "../lib/preferences";
import { pruneExpiredTranscriptions } from "../lib/history";

interface RowProps {
  title: string;
  description: string;
  children: React.ReactNode;
  /** Registry id (src/lib/settingsRegistry.ts) — makes the row a
   *  Cmd+K deep-link target via ?highlight=<id>. */
  id?: string;
}

function SettingRow({ title, description, children, id }: RowProps) {
  return (
    <div
      id={id ? `setting-${id}` : undefined}
      className="flex scroll-mt-24 items-center justify-between gap-6 rounded-md border-b border-border-subtle py-4 transition-shadow last:border-b-0"
    >
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function StageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-2 flex flex-col gap-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent-start">
        {eyebrow}
      </div>
      <div className="text-base font-semibold tracking-tight">{title}</div>
      <div className="max-w-2xl text-xs leading-relaxed text-text-muted">{description}</div>
    </div>
  );
}

function ProviderTestControl({
  id,
  label,
  testing,
  status,
  onTest,
}: {
  id?: string;
  label: string;
  testing: boolean;
  status: ProviderTestStatus | null;
  onTest: () => void;
}) {
  return (
    <div
      id={id ? `setting-${id}` : undefined}
      className="mt-4 scroll-mt-24 rounded-md border border-border-subtle bg-bg-base/40 p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="mt-1 text-xs text-text-muted">
            Runs a health check for this stage and keeps the result here.
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onTest} disabled={testing}>
          {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Test
        </Button>
      </div>
      {status && (
        <div
          className={`mt-3 rounded-md border p-3 text-xs ${
            status.ok
              ? "border-success/30 bg-success/10 text-text-secondary"
              : "border-danger/30 bg-danger/5 text-text-secondary"
          }`}
        >
          <div className={status.ok ? "font-medium text-success" : "font-medium text-danger"}>
            {status.title}
          </div>
          <div className="mt-1">{status.message}</div>
          {!status.ok && status.troubleshoot && (
            <div className="mt-2">
              <span className="font-medium text-text-primary">Troubleshoot: </span>
              {status.troubleshoot}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuntimeRow({
  title,
  description,
  installed,
  installing,
  installLabel = "Install",
  reinstallLabel = "Reinstall",
  onInstall,
}: {
  title: string;
  description: string;
  installed: boolean;
  installing: boolean;
  installLabel?: string;
  reinstallLabel?: string;
  onInstall: () => void;
}) {
  return (
    <SettingRow title={title} description={description}>
      <div className="flex items-center gap-2">
        {installed ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> Installed
          </span>
        ) : (
          <span className="text-xs text-text-muted">Not installed</span>
        )}
        <Button variant="secondary" size="sm" onClick={onInstall} disabled={installing}>
          {installing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {installed ? reinstallLabel : installLabel}
        </Button>
      </div>
    </SettingRow>
  );
}

function ThemeSelect() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.set);
  return (
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
  );
}

function OverlayPositionSelect() {
  const [v, setV] = useState<OverlayPosition>(loadOverlayPosition());
  return (
    <Select
      value={v}
      onValueChange={(next) => {
        const np = next as OverlayPosition;
        setOverlayPosition(np);
        setV(np);
      }}
    >
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
  );
}

function MicrophoneSelect() {
  const [deviceId, setDeviceId] = useState<string>(getMicDeviceId());
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        // Labels are only populated once mic permission is granted.
        // Onboarding already requests it, but request again here so the
        // dropdown shows readable names even on a fresh profile.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* permission denied — we'll still list devices without labels */
      }
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) {
          setDevices(
            all.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default"),
          );
        }
      } catch {
        /* enumerateDevices unsupported — leave list empty */
      }
    };
    void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, []);

  return (
    <Select
      value={deviceId || "default"}
      onValueChange={(next) => {
        const id = next === "default" ? "" : next;
        setMicDeviceId(id);
        setDeviceId(id);
      }}
    >
      <SelectTrigger className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">System default</SelectItem>
        {devices.map((d, i) => (
          <SelectItem key={d.deviceId} value={d.deviceId}>
            {d.label || `Microphone ${i + 1}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ClipboardBehaviorSelect() {
  const [value, setValue] = useState<OutputBehavior>(() => getOutputBehavior());
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const behavior = next as OutputBehavior;
        setOutputBehavior(behavior);
        setValue(behavior);
      }}
    >
      <SelectTrigger className="w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="copy">Paste and keep copied</SelectItem>
        <SelectItem value="insert-only">Paste without clipboard</SelectItem>
        <SelectItem value="restore">Paste then restore previous clipboard</SelectItem>
      </SelectContent>
    </Select>
  );
}

function PasteMethodSelect() {
  const [value, setValue] = useState<PasteMethod>(() => getPasteMethod());
  const autoLabel = osKind() === "linux" ? "Auto (direct type)" : "Auto (⌘/Ctrl+V)";
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const method = next as PasteMethod;
        setPasteMethod(method);
        setValue(method);
      }}
    >
      <SelectTrigger className="w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">{autoLabel}</SelectItem>
        <SelectItem value="ctrl-v">⌘/Ctrl+V</SelectItem>
        <SelectItem value="shift-insert">Shift+Insert</SelectItem>
        <SelectItem value="direct">Direct type</SelectItem>
      </SelectContent>
    </Select>
  );
}

function HistoryRetentionSelect() {
  const [v, setV] = useState<string>(() => String(getHistoryRetentionDays() ?? "forever"));
  return (
    <Select
      value={v}
      onValueChange={(next) => {
        setV(next);
        const days = next === "forever" ? null : (Number(next) as HistoryRetentionDays);
        setHistoryRetentionDays(days);
        void pruneExpiredTranscriptions()
          .then((n) => {
            if (n > 0) toast.success(`Deleted ${n} old transcript${n === 1 ? "" : "s"}`);
          })
          .catch(() => {});
      }}
    >
      <SelectTrigger className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="forever">Forever</SelectItem>
        <SelectItem value="90">90 days</SelectItem>
        <SelectItem value="30">30 days</SelectItem>
        <SelectItem value="7">7 days</SelectItem>
      </SelectContent>
    </Select>
  );
}

function HistoryDisabledSwitch() {
  const [off, setOff] = useState(isHistoryDisabled());
  return (
    <Switch
      checked={!off}
      onCheckedChange={(v) => {
        setHistoryDisabled(!v);
        setOff(!v);
      }}
    />
  );
}

function currentRecordingEngine(): RecordingEngine {
  return getRecordingEngine();
}

/**
 * Recording engine selector (docs/proposals/warm-ptt-capture.md). One clean
 * control instead of two hidden flags:
 * - standard: WebAudio getUserMedia (opens the mic on each press).
 * - fast: native cpal capture, mic kept warm briefly then idle-closed.
 * - instant: native capture with a persistent warm stream + pre-roll, so the
 *   first push-to-talk press is instant — but the macOS mic indicator stays on.
 */
function RecordingEngineRow() {
  const [engine, setEngine] = useState<RecordingEngine>(currentRecordingEngine());

  const onChange = async (value: string) => {
    const next = value as RecordingEngine;
    setEngine(next);
    setRecordingEngine(next);
    try {
      await syncNativeCaptureArm();
    } catch {
      /* best-effort: capture still works, just not pre-warmed */
    }
    toast.success("Recording engine updated", {
      description:
        next === "instant"
          ? "Instant — mic stays on for zero-delay push-to-talk."
          : next === "fast"
            ? "Fast — native capture, mic warm between dictations."
            : "Standard — WebAudio recorder.",
    });
  };

  return (
    <SettingRow
      id="recording-engine"
      title="Recording engine"
      description={
        engine === "instant"
          ? "Keeps the microphone open so push-to-talk starts with no delay. The macOS mic indicator stays on the whole time the app runs."
          : engine === "fast"
            ? "Captures natively and keeps the mic warm between dictations, closing it when idle."
            : "Built-in WebAudio recorder. Most compatible; opens the mic on each press."
      }
    >
      <Select value={engine} onValueChange={(v) => void onChange(v)}>
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="standard">Standard</SelectItem>
          <SelectItem value="fast">Fast (warm on use)</SelectItem>
          <SelectItem value="instant">Instant (mic stays on)</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

function VersionRow() {
  const [version, setVersion] = useState<string>("");
  useEffect(() => {
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setVersion(await getVersion());
      } catch {
        setVersion("(unknown)");
      }
    })();
  }, []);
  return (
    <SettingRow
      id="version"
      title="Version"
      description="The version of Verbatim AI currently running."
    >
      <span className="rounded bg-bg-elevated px-2 py-1 font-mono text-xs text-text-secondary">
        {version || "…"}
      </span>
    </SettingRow>
  );
}

function UpdateSettingRow() {
  const [status, setStatus] = useState<UpdateStatus>(getUpdateStatus());
  useEffect(() => subscribeUpdateStatus(setStatus), []);

  const { description, action } = renderUpdate(status);
  return (
    <SettingRow id="updates" title="App updates" description={description}>
      {action}
    </SettingRow>
  );

  function renderUpdate(s: UpdateStatus): {
    description: string;
    action: React.ReactNode;
  } {
    switch (s.kind) {
      case "idle":
        return {
          description: "Check GitHub for a newer version of Verbatim AI.",
          action: (
            <Button variant="secondary" size="sm" onClick={() => void checkForUpdate()}>
              Check for updates
            </Button>
          ),
        };
      case "checking":
        return {
          description: "Checking GitHub for a newer version…",
          action: (
            <Button variant="secondary" size="sm" disabled>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Checking
            </Button>
          ),
        };
      case "up-to-date":
        return {
          description: "You're on the latest version.",
          action: (
            <Button variant="secondary" size="sm" onClick={() => void checkForUpdate()}>
              Check again
            </Button>
          ),
        };
      case "available":
        return {
          description: `Verbatim AI ${s.version} is available — starting download…`,
          action: (
            <Button variant="secondary" size="sm" disabled>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Starting
            </Button>
          ),
        };
      case "downloading": {
        const pct = s.totalBytes > 0 ? Math.round((s.downloadedBytes / s.totalBytes) * 100) : 0;
        return {
          description: `Downloading Verbatim AI ${s.version}…`,
          action: (
            <Button variant="secondary" size="sm" disabled>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              {s.totalBytes > 0 ? `${pct}%` : "Downloading"}
            </Button>
          ),
        };
      }
      case "ready":
        return {
          description: `Verbatim AI ${s.version} downloaded. Install will restart the app.`,
          action: (
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                try {
                  await installAndRelaunch();
                } catch (e) {
                  toast.error("Couldn't install update", {
                    description: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
            >
              Install and restart
            </Button>
          ),
        };
      case "manual-required":
        return {
          description: s.instructions,
          action: (
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                try {
                  const { openUrl } = await import("@tauri-apps/plugin-opener");
                  await openUrl(s.downloadUrl);
                } catch (e) {
                  toast.error("Couldn't open the download page", {
                    description: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
            >
              Download update
            </Button>
          ),
        };
      case "error":
        return {
          description: `Update check failed: ${s.message}`,
          action: (
            <Button variant="secondary" size="sm" onClick={() => void checkForUpdate()}>
              Retry
            </Button>
          ),
        };
    }
  }
}

const VALID_TABS = ["general", "model", "recording", "privacy", "advanced"];

export default function Settings() {
  const navigate = useNavigate();
  const location = useLocation();
  const [hotkey, setHotkey] = useState(() => loadHotkeyConfig());
  const [autostart, setAutostartState] = useState(false);
  const forcedHold = isForcedHoldSpec(hotkey.spec);

  // Tab + row deep-linking for the Cmd+K palette:
  // /settings?tab=recording&highlight=hotkey
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const stateTab = (location.state as { settingsTab?: string } | null)?.settingsTab;
  const tab =
    tabParam && VALID_TABS.includes(tabParam)
      ? tabParam
      : stateTab && VALID_TABS.includes(stateTab)
        ? stateTab
        : "general";
  const highlight = searchParams.get("highlight");

  useEffect(() => {
    if (!highlight) return;
    // Wait a frame so the tab's content is mounted before we scroll.
    const t = setTimeout(() => {
      const el = document.getElementById(`setting-${highlight}`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("ring-2", "ring-accent-solid/60");
      setTimeout(() => el.classList.remove("ring-2", "ring-accent-solid/60"), 2000);
    }, 60);
    return () => clearTimeout(t);
  }, [highlight, tab]);

  useEffect(() => {
    saveHotkeyConfig(hotkey);
  }, [hotkey]);

  useEffect(() => {
    void isAutostartEnabled().then(setAutostartState);
  }, []);

  const handleHotkeyChange = async (spec: string) => {
    try {
      await applyHotkey(spec);
      setHotkey((h) => ({ ...h, spec, pushToTalk: h.pushToTalk || isForcedHoldSpec(spec) }));
      toast.success("Hotkey updated", { description: `Now using ${spec}` });
    } catch (e) {
      if (!handleInputMonitoringError(e)) {
        toast.error("Couldn't register that shortcut", {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  return (
    <PageContainer>
      <PageHeader title="Settings" description="Configure Verbatim AI to fit your workflow." />
      <Tabs value={tab} onValueChange={(v) => setSearchParams({ tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="model">AI model</TabsTrigger>
          <TabsTrigger value="recording">Recording</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow
                id="autostart"
                title="Launch at startup"
                description={`Open Verbatim AI when ${osName()} starts.`}
              >
                <Switch
                  checked={autostart}
                  onCheckedChange={async (v) => {
                    try {
                      await setAutostart(v);
                      setAutostartState(v);
                    } catch (e) {
                      toast.error("Couldn't update autostart", {
                        description: e instanceof Error ? e.message : String(e),
                      });
                    }
                  }}
                />
              </SettingRow>
              <SettingRow
                id="theme"
                title="Theme"
                description={`Match ${osName()} or pick light/dark.`}
              >
                <ThemeSelect />
              </SettingRow>
              <VersionRow />
              <UpdateSettingRow />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="model">
          <ModelTab />
        </TabsContent>

        <TabsContent value="recording">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow
                id="hotkey"
                title="Global hotkey"
                description="Hold to dictate from anywhere."
              >
                <HotkeyRecorder value={hotkey.spec} onChange={handleHotkeyChange} />
              </SettingRow>
              <SettingRow
                id="microphone"
                title="Microphone"
                description="Input device used for recording."
              >
                <MicrophoneSelect />
              </SettingRow>
              <SettingRow
                id="push-to-talk"
                title="Push-to-talk"
                description={
                  forcedHold
                    ? "fn and right ⌘ always record while held, so a stray tap can't start dictation."
                    : "Hold to record. Off = tap to toggle."
                }
              >
                <Switch
                  checked={forcedHold || hotkey.pushToTalk}
                  disabled={forcedHold}
                  onCheckedChange={(checked) => setHotkey((h) => ({ ...h, pushToTalk: checked }))}
                />
              </SettingRow>
              <SettingRow
                id="clipboard-behavior"
                title="Clipboard behavior"
                description="For clipboard-based paste methods, choose whether dictation stays copied or restores your previous clipboard. Direct output bypasses the clipboard."
              >
                <ClipboardBehaviorSelect />
              </SettingRow>
              <SettingRow
                id="paste-method"
                title="Paste method"
                description="Choose the keystroke used to paste. Auto keeps ⌘/Ctrl+V on macOS/Windows and direct-types on Linux; no-clipboard output always direct-types."
              >
                <PasteMethodSelect />
              </SettingRow>
              <SettingRow
                id="overlay-position"
                title="Recording pill position"
                description="Where the floating pill appears while you talk."
              >
                <OverlayPositionSelect />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow
                id="history-save"
                title="Save transcription history"
                description="When off, transcripts are not saved anywhere — your dictation still works and pastes/reviews as normal, but nothing is written to the History page. Overrides the per-mode setting."
              >
                <HistoryDisabledSwitch />
              </SettingRow>
              <SettingRow
                id="history-retention"
                title="History retention"
                description="Automatically delete transcripts older than this. Applies on app start."
              >
                <HistoryRetentionSelect />
              </SettingRow>
              <SettingRow
                id="telemetry"
                title="Anonymous telemetry"
                description="Help improve Verbatim AI. Never your transcript content."
              >
                <Switch />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="advanced">
          <Card>
            <CardContent className="p-5 pt-5">
              <RecordingEngineRow />
              <SettingRow id="log-level" title="Log level" description="Verbosity of log files.">
                <Select defaultValue="info">
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="error">Error</SelectItem>
                    <SelectItem value="warn">Warn</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                    <SelectItem value="debug">Debug</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                id="rerun-onboarding"
                title="Re-run onboarding"
                description="Walk through the welcome flow again to reconfigure tone presets."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    useOnboarding.getState().reset();
                    navigate("/onboarding", { replace: true });
                  }}
                >
                  Restart
                </Button>
              </SettingRow>
              <SettingRow
                id="devtools"
                title="Open developer tools"
                description="Show the WebView2 dev tools for the main window. Use the Console tab to see app logs (Ollama, transcription, updates, etc)."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("open_main_devtools");
                    } catch (e) {
                      toast.error("Couldn't open dev tools", {
                        description: e instanceof Error ? e.message : String(e),
                      });
                    }
                  }}
                >
                  Open
                </Button>
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

// --------------------------------------------------------------------------
// AI model tab
// --------------------------------------------------------------------------

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function ModelTab() {
  const [kind, setKind] = useState<AiProviderKind>(getAiProviderKind());
  const [selectedTier, setSelectedTier] = useState<WhisperModelId>(getLocalWhisperTier());
  const [computePreference, setComputePreference] = useState<WhisperComputePreference>(
    getWhisperComputePreference(),
  );
  const [activeRuntime, setActiveRuntime] = useState<WhisperRuntimeVariant | null>(null);
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [customModels, setCustomModels] = useState<CustomModelInfo[]>([]);
  const [rescanning, setRescanning] = useState(false);
  const [runtimeInstalled, setRuntimeInstalled] = useState<boolean>(false);
  const [installingRuntime, setInstallingRuntime] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);
  const [downloading, setDownloading] = useState<
    Record<WhisperTier, { downloaded: number; total: number } | undefined>
  >({} as Record<WhisperTier, { downloaded: number; total: number } | undefined>);
  const [transcriptionTest, setTranscriptionTest] = useState<ProviderTestStatus | null>(null);
  const [testingTranscription, setTestingTranscription] = useState(false);

  const refresh = async () => {
    try {
      const [m, custom, rt, active] = await Promise.all([
        listLocalModels(),
        listCustomWhisperModels(),
        isWhisperRuntimeInstalled(),
        getActiveWhisperRuntimeVariant(),
      ]);
      setModels(m);
      setCustomModels(custom);
      setRuntimeInstalled(rt);
      setActiveRuntime(active);
    } catch (e) {
      toast.error("Couldn't read local Whisper state", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const offDl = listen<{ tier: WhisperTier; downloaded: number; total: number }>(
      "local-whisper:download:progress",
      (e) => {
        setDownloading((d) => ({
          ...d,
          [e.payload.tier]: { downloaded: e.payload.downloaded, total: e.payload.total },
        }));
      },
    );
    const offDone = listen<string>("local-whisper:download:complete", (e) => {
      setDownloading((d) => ({ ...d, [e.payload as WhisperTier]: undefined }));
      void refresh();
    });
    const offRtProg = listen<{ downloaded: number; total: number }>(
      "local-whisper:runtime:progress",
      (e) => setInstallingRuntime({ downloaded: e.payload.downloaded, total: e.payload.total }),
    );
    const offRtDone = listen<string>("local-whisper:runtime:complete", () => {
      setInstallingRuntime(null);
      void refresh();
    });
    return () => {
      void offDl.then((fn) => fn());
      void offDone.then((fn) => fn());
      void offRtProg.then((fn) => fn());
      void offRtDone.then((fn) => fn());
    };
  }, []);

  // The whisper.cpp runtime is an implementation detail — install it
  // automatically whenever it's needed so the user never has to think
  // about it (manual reinstall lives behind "Show advanced settings").
  const ensureRuntime = async () => {
    if (runtimeInstalled || installingRuntime) return;
    setInstallingRuntime({ downloaded: 0, total: 0 });
    try {
      await installWhisperRuntime();
    } catch (e) {
      setInstallingRuntime(null);
      throw e;
    }
  };

  const handleProviderChange = (next: AiProviderKind) => {
    setAiProviderKind(next);
    setKind(next);
    toast.success(next === "cloud" ? "Using cloud (Azure Whisper)" : "Using local Whisper");
    if (next === "local-whisper" && !runtimeInstalled) {
      void ensureRuntime().catch((e) => {
        toast.error("Couldn't set up the Whisper runtime", {
          description: e instanceof Error ? e.message : String(e),
        });
      });
    }
  };

  const handleTierChange = (tier: WhisperModelId) => {
    setLocalWhisperTier(tier);
    setSelectedTier(tier);
  };

  const handleRescan = async () => {
    setRescanning(true);
    try {
      const found = await rescanLocalModels();
      setCustomModels(found);
      toast.success(
        found.length === 1
          ? "Found 1 custom model"
          : `Found ${found.length} custom models`,
      );
    } catch (e) {
      toast.error("Couldn't scan for custom models", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRescanning(false);
    }
  };

  const handleComputeChange = (next: WhisperComputePreference) => {
    setWhisperComputePreference(next);
    setComputePreference(next);
    setRuntimeInstalled(false);
    void refresh();
  };

  const handleDownload = async (tier: WhisperTier) => {
    setDownloading((d) => ({ ...d, [tier]: { downloaded: 0, total: 0 } }));
    try {
      await ensureRuntime();
      await downloadLocalModel(tier);
      toast.success(`Downloaded ${tier}`);
    } catch (e) {
      toast.error("Download failed", { description: e instanceof Error ? e.message : String(e) });
      setDownloading((d) => ({ ...d, [tier]: undefined }));
    }
  };

  const handleDelete = async (id: WhisperModelId) => {
    try {
      await deleteLocalModel(id);
      // If the deleted model was selected, fall back to the default tier.
      if (selectedTier === id && id !== "turbo") {
        handleTierChange("turbo");
      }
      toast.success(`Removed ${id.replace("custom:", "")}`);
      void refresh();
    } catch (e) {
      toast.error("Couldn't remove model", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleInstallRuntime = async () => {
    setInstallingRuntime({ downloaded: 0, total: 0 });
    try {
      await installWhisperRuntime();
      toast.success("whisper.cpp runtime installed");
    } catch (e) {
      toast.error("Couldn't install runtime", {
        description: e instanceof Error ? e.message : String(e),
      });
      setInstallingRuntime(null);
    }
  };

  const handleTestTranscription = async () => {
    setTestingTranscription(true);
    setTranscriptionTest(null);
    try {
      const health = await testTranscriptionProvider();
      setTranscriptionTest(providerTestStatus("transcription", health));
    } catch (e) {
      setTranscriptionTest(
        providerTestStatus("transcription", {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setTestingTranscription(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-5 pt-5">
          <StageHeader
            eyebrow="Step 1"
            title="Transcription"
            description="Turn audio into text. Pick the engine first, then tune the model options that belong to that engine."
          />
          <SettingRow
            id="transcription-provider"
            title="Transcription engine"
            description={
              CLOUD_FEATURES_ENABLED
                ? "Where speech-to-text runs. Cloud is the default. Local engines keep audio on this machine once a model is downloaded."
                : "Where speech-to-text runs. Whisper and Parakeet keep audio on this machine once a model is downloaded."
            }
          >
            <Select value={kind} onValueChange={(v) => handleProviderChange(v as AiProviderKind)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLOUD_FEATURES_ENABLED && (
                  <SelectItem value="cloud">Cloud — Azure Whisper</SelectItem>
                )}
                <SelectItem value="local-whisper">Local — Whisper</SelectItem>
                <SelectItem value="local-parakeet">Local — Parakeet</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <div className="pt-3 text-xs text-text-muted">
            Cleanup and tone polish are configured separately in the next section.
          </div>

          {kind === "cloud" && (
            <div className="mt-5 rounded-md border border-border-subtle bg-bg-base/40 p-4">
              <div className="text-sm font-medium">Azure Whisper</div>
              <div className="mt-1 text-xs leading-relaxed text-text-muted">
                No local model download is needed. Audio is sent to the Verbatim cloud just long
                enough to transcribe it.
              </div>
            </div>
          )}

          <ProviderTestControl
            id="test-transcription"
            label="Test transcription"
            testing={testingTranscription}
            status={transcriptionTest}
            onTest={handleTestTranscription}
          />

          {kind === "local-whisper" && (
            <div className="mt-5 border-t border-border-subtle pt-5">
              <div className="mb-3 text-sm font-medium">Whisper.cpp models</div>
              <div className="mb-4 text-xs text-text-muted">
                Local Whisper uses whisper.cpp, the ggml speech-to-text runtime. Pick a tier based
                on your machine. Larger = more accurate, slower. The runtime is set up automatically
                with your first download.
              </div>
              <SettingRow
                title="Compute device"
                description={`Auto currently resolves to ${
                  activeRuntime
                    ? whisperRuntimeVariantLabel(activeRuntime)
                    : "the best available backend"
                }.`}
              >
                <Select
                  value={computePreference}
                  onValueChange={(v) => handleComputeChange(v as WhisperComputePreference)}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["auto", "cuda", "vulkan", "cpu"] as WhisperComputePreference[]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {whisperComputePreferenceLabel(v)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              {installingRuntime && (
                <div className="mb-3 rounded-md border border-border-subtle bg-bg-elevated/40 p-3">
                  <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Setting up the on-device engine (one time, ~5 MB)…
                  </div>
                  {installingRuntime.total > 0 && (
                    <ProgressBar
                      value={Math.round(
                        (installingRuntime.downloaded / installingRuntime.total) * 100,
                      )}
                    />
                  )}
                </div>
              )}
              <RuntimeRow
                title="Runtime"
                description={`Downloads the ${
                  activeRuntime ? whisperRuntimeVariantLabel(activeRuntime) : "selected"
                } whisper.cpp sidecar used for local speech-to-text.`}
                installed={runtimeInstalled}
                installing={!!installingRuntime}
                onInstall={handleInstallRuntime}
              />
              <div className="flex flex-col gap-2">
                {WHISPER_TIERS.map((meta) => {
                  const info = models.find((m) => m.tier === meta.tier);
                  const installed = !!info?.installed;
                  const isSelected = selectedTier === meta.tier;
                  const dl = downloading[meta.tier];
                  const dlPct =
                    dl && dl.total > 0 ? Math.round((dl.downloaded / dl.total) * 100) : undefined;
                  return (
                    <div
                      key={meta.tier}
                      className={`flex flex-col gap-2 rounded-md border p-3 ${
                        isSelected ? "border-accent bg-accent/5" : "border-border-subtle"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{meta.label}</span>
                            <span className="text-xs text-text-muted">·</span>
                            <span className="text-xs text-text-muted">{meta.tier}</span>
                            <span className="text-xs text-text-muted">·</span>
                            <span className="text-xs text-text-muted">
                              {formatSize(meta.approxSizeMB)}
                            </span>
                            {installed && (
                              <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> installed
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-text-muted">{meta.blurb}</div>
                          <div className="text-xs text-text-muted">
                            Best for: {meta.recommendedFor}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {installed ? (
                            <>
                              <Button
                                variant={isSelected ? "primary" : "secondary"}
                                size="sm"
                                onClick={() => handleTierChange(meta.tier)}
                                disabled={isSelected}
                              >
                                {isSelected ? "In use" : "Use this"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDelete(meta.tier)}
                                title="Remove model file"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          ) : dl ? (
                            <Button variant="secondary" size="sm" disabled>
                              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                              {dlPct !== undefined ? `${dlPct}%` : "Starting…"}
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleDownload(meta.tier)}
                            >
                              <Download className="mr-1 h-4 w-4" />
                              Download
                            </Button>
                          )}
                        </div>
                      </div>
                      {dl && dlPct !== undefined && <ProgressBar value={dlPct} />}
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 border-t border-border-subtle pt-5">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">Custom models</div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleRescan}
                    disabled={rescanning}
                  >
                    {rescanning ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-4 w-4" />
                    )}
                    Rescan
                  </Button>
                </div>
                <div className="mb-3 text-xs text-text-muted">
                  Bring your own model: drop a <code>.bin</code> or <code>.gguf</code> whisper.cpp
                  model into the models folder, then Rescan to select it here.
                </div>
                {customModels.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border-subtle p-3 text-xs text-text-muted">
                    No custom models found. Add a <code>.bin</code>/<code>.gguf</code> file to the
                    whisper-models folder and press Rescan.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {customModels.map((cm) => {
                      const isSelected = selectedTier === cm.id;
                      return (
                        <div
                          key={cm.id}
                          className={`flex items-start justify-between gap-3 rounded-md border p-3 ${
                            isSelected ? "border-accent bg-accent/5" : "border-border-subtle"
                          }`}
                        >
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {cm.displayName}
                              </span>
                              <span className="text-xs text-text-muted">·</span>
                              <span className="text-xs text-text-muted">Custom</span>
                              <span className="text-xs text-text-muted">·</span>
                              <span className="text-xs text-text-muted">
                                {formatBytes(cm.sizeBytes)}
                              </span>
                              <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> installed
                              </span>
                            </div>
                            <div className="truncate text-xs text-text-muted">{cm.fileName}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              variant={isSelected ? "primary" : "secondary"}
                              size="sm"
                              onClick={() => handleTierChange(cm.id)}
                              disabled={isSelected}
                            >
                              {isSelected ? "In use" : "Use this"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(cm.id)}
                              title="Remove model file"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {kind === "local-parakeet" && <ParakeetSection />}
        </CardContent>
      </Card>

      <CleanupSection />
    </div>
  );
}

// --------------------------------------------------------------------------
// Cleanup provider section (cloud vs local Ollama)
// --------------------------------------------------------------------------

function formatBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  return `${b} B`;
}

// --------------------------------------------------------------------------
// Parakeet TDT v3 section (on-device, multilingual, sherpa-onnx)
// --------------------------------------------------------------------------

function ParakeetSection() {
  const [runtimeInstalled, setRuntimeInstalled] = useState<boolean>(false);
  const [models, setModels] = useState<ParakeetModelInfo[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<ParakeetVariant>(getParakeetVariant());
  const [installingRuntime, setInstallingRuntime] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);
  const [downloading, setDownloading] = useState<
    Record<ParakeetVariant, { downloaded: number; total: number } | undefined>
  >({} as Record<ParakeetVariant, { downloaded: number; total: number } | undefined>);
  const [language, setLanguageState] = useState<string>(getParakeetLanguage());

  const refresh = async () => {
    try {
      const [rt, m] = await Promise.all([isParakeetRuntimeInstalled(), listParakeetModels()]);
      setRuntimeInstalled(rt);
      setModels(m);
    } catch (e) {
      toast.error("Couldn't read Parakeet state", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const offRtProg = listen<{ downloaded: number; total: number }>(
      "parakeet:runtime:progress",
      (e) => setInstallingRuntime({ downloaded: e.payload.downloaded, total: e.payload.total }),
    );
    const offRtDone = listen<string>("parakeet:runtime:complete", () => {
      setInstallingRuntime(null);
      void refresh();
    });
    const offDlProg = listen<{ downloaded: number; total: number }>(
      "parakeet:download:progress",
      (e) => {
        // Sherpa-onnx doesn't tag progress with the variant, but only one
        // download runs at a time. Apply to whichever variant is in-flight.
        setDownloading((d) => {
          const inflight = (Object.keys(d) as ParakeetVariant[]).find((k) => d[k] !== undefined);
          if (!inflight) return d;
          return { ...d, [inflight]: { downloaded: e.payload.downloaded, total: e.payload.total } };
        });
      },
    );
    const offDlDone = listen<string>("parakeet:download:complete", (e) => {
      const v = (e.payload === "v2" ? "v2" : "v3") as ParakeetVariant;
      setDownloading((d) => ({ ...d, [v]: undefined }));
      void refresh();
    });
    return () => {
      void offRtProg.then((fn) => fn());
      void offRtDone.then((fn) => fn());
      void offDlProg.then((fn) => fn());
      void offDlDone.then((fn) => fn());
    };
  }, []);

  const handleInstallRuntime = async () => {
    setInstallingRuntime({ downloaded: 0, total: 0 });
    try {
      await installParakeetRuntime();
      toast.success("Sherpa-onnx runtime installed");
    } catch (e) {
      toast.error("Couldn't install runtime", {
        description: e instanceof Error ? e.message : String(e),
      });
      setInstallingRuntime(null);
    }
  };

  // Runtime is an implementation detail — auto-install on first model
  // download; manual controls live behind "Show advanced settings".
  const ensureRuntime = async () => {
    if (runtimeInstalled || installingRuntime) return;
    setInstallingRuntime({ downloaded: 0, total: 0 });
    try {
      await installParakeetRuntime();
    } catch (e) {
      setInstallingRuntime(null);
      throw e;
    }
  };

  const handleVariantChange = (v: ParakeetVariant) => {
    setParakeetVariant(v);
    setSelectedVariant(v);
  };

  const handleDownload = async (v: ParakeetVariant) => {
    setDownloading((d) => ({ ...d, [v]: { downloaded: 0, total: 0 } }));
    try {
      await ensureRuntime();
      await downloadParakeetModel(v);
      toast.success(`Parakeet ${v} model downloaded`);
    } catch (e) {
      toast.error("Download failed", {
        description: e instanceof Error ? e.message : String(e),
      });
      setDownloading((d) => ({ ...d, [v]: undefined }));
    }
  };

  const handleDelete = async (v: ParakeetVariant) => {
    try {
      await deleteParakeetModel(v);
      toast.success(`Parakeet ${v} model removed`);
      void refresh();
    } catch (e) {
      toast.error("Couldn't remove model", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleLanguageChange = (code: string) => {
    setParakeetLanguage(code);
    setLanguageState(code);
  };

  const rtPct =
    installingRuntime && installingRuntime.total > 0
      ? Math.round((installingRuntime.downloaded / installingRuntime.total) * 100)
      : undefined;

  return (
    <div className="mt-5 border-t border-border-subtle pt-5">
      <div className="mb-3 text-sm font-medium">Parakeet TDT</div>
      <div className="mb-4 text-xs text-text-muted">
        On-device transcription via the sherpa-onnx runtime. Pick a model variant — v2 for
        English-only with the best WER, or v3 for 25 European languages. Runs on CPU. Windows x64
        and Apple Silicon only.
      </div>

      {installingRuntime && (
        <div className="mb-3 rounded-md border border-border-subtle bg-bg-elevated/40 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Setting up the on-device engine (one time, ~50 MB)…
          </div>
          {rtPct !== undefined && <ProgressBar value={rtPct} />}
        </div>
      )}

      {/* Model variants */}
      <div className="mb-3 text-sm font-medium">Models</div>
      <div className="mb-4 text-xs text-text-muted">
        Pick the variant that fits your needs. Both can be installed; the selected one is used for
        new recordings. Everything needed to run them is set up automatically with your first
        download.
      </div>
      <div className="flex flex-col gap-2">
        {PARAKEET_VARIANTS.map((meta) => {
          const info = models.find((m) => m.variant === meta.variant);
          const installed = !!info?.installed;
          const isSelected = selectedVariant === meta.variant;
          const dl = downloading[meta.variant];
          const dlPct =
            dl && dl.total > 0 ? Math.round((dl.downloaded / dl.total) * 100) : undefined;
          return (
            <div
              key={meta.variant}
              className={`flex flex-col gap-2 rounded-md border p-3 ${
                isSelected ? "border-accent bg-accent/5" : "border-border-subtle"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{meta.label}</span>
                    <span className="text-xs text-text-muted">·</span>
                    <span className="text-xs text-text-muted">~{meta.approxSizeMB} MB</span>
                    {installed && (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <CheckCircle2 className="h-3.5 w-3.5" /> installed
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted">{meta.blurb}</div>
                  <div className="text-xs text-text-muted">Best for: {meta.recommendedFor}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {installed ? (
                    <>
                      <Button
                        variant={isSelected ? "primary" : "secondary"}
                        size="sm"
                        onClick={() => handleVariantChange(meta.variant)}
                        disabled={isSelected}
                      >
                        {isSelected ? "In use" : "Use this"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(meta.variant)}
                        title="Remove model file"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : dl ? (
                    <Button variant="secondary" size="sm" disabled>
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      {dlPct !== undefined ? `${dlPct}%` : "Starting…"}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleDownload(meta.variant)}
                    >
                      <Download className="mr-1 h-4 w-4" /> Download
                    </Button>
                  )}
                </div>
              </div>
              {dl && dlPct !== undefined && <ProgressBar value={dlPct} />}
            </div>
          );
        })}
      </div>

      {/* Language */}
      <div className="pt-3">
        <SettingRow
          id="transcription-language"
          title="Language"
          description="Pick a specific language for best accuracy, or let the model auto-detect. (v2 is English-only regardless.)"
        >
          <Select value={language} onValueChange={handleLanguageChange}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PARAKEET_LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <RuntimeRow
        title="Runtime"
        description="Downloads the sherpa-onnx sidecar used for Parakeet transcription."
        installed={runtimeInstalled}
        installing={!!installingRuntime}
        onInstall={handleInstallRuntime}
      />
    </div>
  );
}

// "none" = skip the LLM polish entirely (vocabulary replacements still
// run). Stored as the existing sw.ai.disabled flag, so the overlay
// pipeline and privacy indicator already understand it.
type CleanupChoice = CleanupProviderKind | "none";

function CleanupSection() {
  const [kind, setKind] = useState<CleanupChoice>(() =>
    isAiImproveDisabled() ? "none" : getCleanupProviderKind(),
  );
  const [host, setHostState] = useState<string>(getOllamaHost());
  const [model, setModelState] = useState<string>(getOllamaModel());
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [ping, setPing] = useState<PingResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [llamaModel, setLlamaModel] = useState<string>(getLlamaCppModel());
  const [llamaRuntimeInstalled, setLlamaRuntimeInstalled] = useState(false);
  const [installingLlamaRuntime, setInstallingLlamaRuntime] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);
  const [cleanupTest, setCleanupTest] = useState<ProviderTestStatus | null>(null);
  const [testingCleanup, setTestingCleanup] = useState(false);
  const reachable = ping?.kind === "ok";

  const refresh = async () => {
    setRefreshing(true);
    try {
      const p = await pingOllama(host);
      setPing(p);
      if (p.kind === "ok") {
        const list = await listOllamaModels(host);
        setModels(list);
        // If the saved model isn't present, clear it so we don't silently use
        // something the user can no longer run.
        if (model && !list.find((m) => m.name === model)) {
          setOllamaModel("");
          setModelState("");
        }
      } else {
        setModels([]);
      }
    } catch (e) {
      setPing({ kind: "unreachable", message: e instanceof Error ? e.message : String(e) });
      setModels([]);
      toast.error("Couldn't talk to Ollama", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (kind === "local-ollama") void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, host]);

  const refreshLlamaRuntime = async () => {
    try {
      setLlamaRuntimeInstalled(await isLlamaCppRuntimeInstalled());
    } catch (e) {
      toast.error("Couldn't read llama.cpp state", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    if (kind === "local-llama-cpp") void refreshLlamaRuntime();
  }, [kind]);

  useEffect(() => {
    const offRtProg = listen<{ downloaded: number; total: number }>(
      "llama-cpp:runtime:progress",
      (e) => setInstallingLlamaRuntime(e.payload),
    );
    const offRtDone = listen<string>("llama-cpp:runtime:complete", () => {
      setInstallingLlamaRuntime(null);
      void refreshLlamaRuntime();
    });
    return () => {
      void offRtProg.then((fn) => fn());
      void offRtDone.then((fn) => fn());
    };
  }, []);

  const handleInstallLlamaRuntime = async () => {
    setInstallingLlamaRuntime({ downloaded: 0, total: 0 });
    try {
      await installLlamaCppRuntime();
      toast.success("llama.cpp runtime installed");
    } catch (e) {
      setInstallingLlamaRuntime(null);
      toast.error("Couldn't install llama.cpp", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleOpenOllamaInstaller = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl("https://ollama.com/download");
      toast.info("Opened Ollama download", {
        description: "Install Ollama, start it, then refresh the Runtime status.",
      });
    } catch (e) {
      toast.error("Couldn't open Ollama download", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleTestCleanup = async () => {
    setTestingCleanup(true);
    setCleanupTest(null);
    try {
      if (kind === "none") {
        setCleanupTest(
          providerTestStatus("cleanup", {
            ok: true,
            message: "Cleanup is disabled. Raw transcript mode is ready.",
          }),
        );
        return;
      }
      const health = await testCleanupProvider();
      setCleanupTest(providerTestStatus("cleanup", health));
    } catch (e) {
      setCleanupTest(
        providerTestStatus("cleanup", {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setTestingCleanup(false);
    }
  };

  const handleKind = (next: CleanupChoice) => {
    if (next === "none") {
      setAiImproveDisabled(true);
    } else {
      setAiImproveDisabled(false);
      setCleanupProviderKind(next);
    }
    setKind(next);
    toast.success(
      next === "cloud"
        ? "Cleanup: using cloud"
        : next === "local-ollama"
          ? "Cleanup: using local Ollama"
          : next === "local-llama-cpp"
            ? "Cleanup: using local llama.cpp"
            : "Cleanup off — you'll get the raw transcript",
    );
  };

  return (
    <Card>
      <CardContent className="p-5 pt-5">
        <StageHeader
          eyebrow="Step 2"
          title="Cleanup"
          description="Turn the transcript into the final text. Pick the cleanup engine first, then choose the model or raw-output behavior inside the same section."
        />
        <SettingRow
          id="cleanup-provider"
          title="Cleanup engine"
          description="Where tone polish and grammar fixes run. This is text cleanup only, independent from transcription."
        >
          <Select value={kind} onValueChange={(v) => handleKind(v as CleanupChoice)}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLOUD_FEATURES_ENABLED && <SelectItem value="cloud">Cloud — Azure GPT</SelectItem>}
              <SelectItem value="local-ollama">Local — Ollama</SelectItem>
              <SelectItem value="local-llama-cpp">Local — llama.cpp</SelectItem>
              <SelectItem value="none">None — raw transcript</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        {kind === "cloud" && (
          <div className="mt-5 rounded-md border border-border-subtle bg-bg-base/40 p-4">
            <div className="text-sm font-medium">Azure GPT cleanup</div>
            <div className="mt-1 text-xs leading-relaxed text-text-muted">
              Uses the active Mode to fix grammar, remove fillers, and shape tone in the cloud. No
              local model setup is required.
            </div>
          </div>
        )}

        {kind === "none" && (
          <div className="mt-5 rounded-md border border-border-subtle bg-bg-base/40 p-4">
            <div className="text-sm font-medium">Raw transcript</div>
            <div className="mt-1 text-xs leading-relaxed text-text-muted">
              Skips the LLM polish step entirely. Vocabulary replacements still apply before the
              text is pasted.
            </div>
          </div>
        )}

        <ProviderTestControl
          id="test-cleanup"
          label="Test cleanup"
          testing={testingCleanup}
          status={cleanupTest}
          onTest={handleTestCleanup}
        />

        {kind === "local-ollama" && (
          <div className="mt-5 border-t border-border-subtle pt-5">
            <div className="mb-3 text-sm font-medium">Ollama cleanup models</div>
            <div className="mb-4 text-xs leading-relaxed text-text-muted">
              Verbatim AI talks to a local Ollama server for text cleanup, not audio transcription.
              Install Ollama once from{" "}
              <a
                href="https://ollama.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-start hover:underline"
              >
                ollama.com <ExternalLink className="h-3 w-3" />
              </a>{" "}
              and pull a model in a terminal:{" "}
              <code className="text-text-primary">ollama pull qwen2.5:7b</code>.
            </div>

            <RuntimeRow
              title="Runtime"
              description="Uses the official Ollama app/server. Install it once, start it, then refresh the status."
              installed={reachable}
              installing={false}
              onInstall={handleOpenOllamaInstaller}
            />

            <SettingRow
              title="Status"
              description="Whether Ollama is currently reachable at the configured host."
            >
              {ping === null ? (
                <span className="text-xs text-text-muted">—</span>
              ) : ping.kind === "ok" ? (
                <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                </span>
              ) : ping.kind === "forbidden" ? (
                <span className="inline-flex items-center gap-1 text-xs text-danger">
                  Blocked (403)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-danger">
                  Not reachable
                </span>
              )}
            </SettingRow>

            <SettingRow
              title="Host"
              description="Default works for local Ollama. Change only if you run it elsewhere."
            >
              <div className="flex items-center gap-2">
                <Input
                  className="w-64"
                  value={host}
                  onChange={(e) => setHostState(e.target.value)}
                  onBlur={() => {
                    setOllamaHost(host);
                    void refresh();
                  }}
                  placeholder="http://localhost:11434"
                />
                <Button variant="ghost" size="icon-sm" onClick={refresh} title="Refresh">
                  <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </SettingRow>

            {ping?.kind === "forbidden" && (
              <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-text-secondary">
                <div className="mb-1 font-medium text-danger">
                  Ollama is rejecting requests from this app (HTTP 403).
                </div>
                Ollama only allows requests from specific origins. Add Verbatim AI to the allowlist:
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>Quit Ollama from the system tray.</li>
                  <li>
                    Open a terminal and run:{" "}
                    <code className="text-text-primary">
                      setx OLLAMA_ORIGINS "tauri://localhost,https://tauri.localhost"
                    </code>{" "}
                    (on macOS/Linux:{" "}
                    <code className="text-text-primary">
                      launchctl setenv OLLAMA_ORIGINS "tauri://localhost,https://tauri.localhost"
                    </code>
                    ). Avoid <code className="text-text-primary">"*"</code> — it lets any website
                    reach your Ollama.
                  </li>
                  <li>Start Ollama again, then click the refresh icon.</li>
                </ol>
              </div>
            )}

            {ping?.kind === "unreachable" && (
              <div className="mt-3 rounded-md border border-border-subtle bg-bg-elevated/40 p-3 text-xs text-text-muted">
                Couldn't reach Ollama at <code className="text-text-primary">{host}</code>. Make
                sure it's installed and running. On {osName()} it should auto-start after install.
              </div>
            )}

            {reachable && (
              <OllamaModelList
                host={host}
                installed={models}
                currentModel={model}
                onPulled={refresh}
                onPick={(name) => {
                  setOllamaModel(name);
                  setModelState(name);
                }}
              />
            )}
          </div>
        )}

        {kind === "local-llama-cpp" && (
          <div className="mt-5 border-t border-border-subtle pt-5">
            <div className="mb-3 text-sm font-medium">llama.cpp cleanup models</div>
            <div className="mb-4 text-xs leading-relaxed text-text-muted">
              llama.cpp runs a local GGUF LLM directly from Verbatim AI for text cleanup. It does
              not transcribe audio; use Whisper or Parakeet above for speech-to-text. Models use
              llama.cpp's Hugging Face shorthand, for example{" "}
              <code className="text-text-primary">ggml-org/gemma-3-1b-it-GGUF</code>.
            </div>

            {installingLlamaRuntime && (
              <div className="mb-3 rounded-md border border-border-subtle bg-bg-elevated/40 p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Installing llama.cpp runtime…
                </div>
                {installingLlamaRuntime.total > 0 && (
                  <ProgressBar
                    value={Math.round(
                      (installingLlamaRuntime.downloaded / installingLlamaRuntime.total) * 100,
                    )}
                  />
                )}
              </div>
            )}

            <SettingRow
              title="Runtime"
              description="Downloads the official prebuilt llama-cli from ggml-org/llama.cpp releases."
            >
              <div className="flex items-center gap-2">
                {llamaRuntimeInstalled ? (
                  <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Installed
                  </span>
                ) : (
                  <span className="text-xs text-text-muted">Not installed</span>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleInstallLlamaRuntime}
                  disabled={!!installingLlamaRuntime}
                >
                  {llamaRuntimeInstalled ? "Reinstall" : "Install"}
                </Button>
              </div>
            </SettingRow>

            <SettingRow
              title="Model"
              description="Pick a suggested GGUF model or paste any llama.cpp-compatible Hugging Face reference."
            >
              <Input
                className="w-80"
                value={llamaModel}
                onChange={(e) => {
                  setLlamaModel(e.target.value);
                  setLlamaCppModel(e.target.value);
                }}
                placeholder="ggml-org/gemma-3-1b-it-GGUF"
              />
            </SettingRow>

            <div className="mt-3 flex flex-col gap-2">
              {LLAMA_CPP_MODELS.map((m) => {
                const selected = llamaModel === m.id;
                return (
                  <div
                    key={m.id}
                    className={`flex items-start justify-between gap-3 rounded-md border p-3 ${
                      selected ? "border-accent bg-accent/5" : "border-border-subtle"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{m.label}</span>
                        {m.recommended && (
                          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-start">
                            Recommended
                          </span>
                        )}
                        <span className="text-xs text-text-muted">·</span>
                        <span className="text-xs text-text-muted">~{formatMB(m.approxDiskMB)}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                        {m.id}
                      </div>
                      <div className="mt-1 text-xs text-text-muted">{m.blurb}</div>
                    </div>
                    <Button
                      variant={selected ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => {
                        setLlamaModel(m.id);
                        setLlamaCppModel(m.id);
                      }}
                      disabled={selected}
                    >
                      {selected ? "In use" : "Use this"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

/**
 * Unified Ollama model picker — one list, styled exactly like the
 * Whisper/Parakeet model lists: suggested models are downloadable in
 * place, installed models (including ones pulled manually) get
 * "Use this" / "In use". Replaces the old separate Model dropdown +
 * "Suggested models" box (user request: one consistent pattern).
 */
function OllamaModelList({
  host,
  installed,
  currentModel,
  onPulled,
  onPick,
}: {
  host: string;
  installed: OllamaModelInfo[];
  currentModel: string;
  onPulled: () => void | Promise<void>;
  onPick: (name: string) => void;
}) {
  const [pulling, setPulling] = useState<
    Record<string, { completed: number; total: number; status: string } | undefined>
  >({});

  const handlePull = async (tag: string) => {
    setPulling((p) => ({ ...p, [tag]: { completed: 0, total: 0, status: "starting" } }));
    try {
      await pullOllamaModel(tag, host, (prog) => {
        setPulling((p) => ({
          ...p,
          [tag]: {
            completed: prog.completed ?? 0,
            total: prog.total ?? 0,
            status: prog.status,
          },
        }));
      });
      toast.success(`Downloaded ${tag}`);
      await onPulled();
      onPick(tag);
    } catch (e) {
      toast.error("Download failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPulling((p) => ({ ...p, [tag]: undefined }));
    }
  };

  const installedByName = new Map(installed.map((m) => [m.name, m]));
  // Suggested first (recommended order), then anything else the user
  // already pulled that we don't have a blurb for.
  const extraInstalled = installed.filter(
    (m) => !SUGGESTED_OLLAMA_MODELS.some((s) => s.tag === m.name),
  );

  interface Row {
    tag: string;
    label: string;
    meta: string;
    blurb: string;
    recommended: boolean;
    isInstalled: boolean;
  }
  const rows: Row[] = [
    ...SUGGESTED_OLLAMA_MODELS.map((m) => ({
      tag: m.tag,
      label: m.label,
      meta: `${formatMB(m.approxDiskMB)} disk · ~${formatMB(m.approxVramMB)} VRAM`,
      blurb: m.blurb,
      recommended: !!m.recommended,
      isInstalled: installedByName.has(m.tag),
    })),
    ...extraInstalled.map((m) => ({
      tag: m.name,
      label: m.name,
      meta: formatBytes(m.sizeBytes),
      blurb: "Pulled into Ollama outside Verbatim AI.",
      recommended: false,
      isInstalled: true,
    })),
  ];

  return (
    <div className="mt-5 border-t border-border-subtle pt-5">
      <div className="mb-3 text-sm font-medium">Ollama models</div>
      <div className="mb-4 text-xs text-text-muted">
        Pick the model used for polish. Downloads go straight into Ollama — or pull anything else
        with <code className="text-text-primary">ollama pull &lt;tag&gt;</code> in a terminal.
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((m) => {
          const selected = currentModel === m.tag;
          const p = pulling[m.tag];
          const pct = p && p.total > 0 ? Math.round((p.completed / p.total) * 100) : undefined;
          return (
            <div
              key={m.tag}
              className={`flex flex-col gap-2 rounded-md border p-3 ${
                selected ? "border-accent bg-accent/5" : "border-border-subtle"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{m.label}</span>
                    {m.recommended && (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-start">
                        Recommended
                      </span>
                    )}
                    {m.label !== m.tag && (
                      <>
                        <span className="text-xs text-text-muted">·</span>
                        <span className="text-xs text-text-muted">
                          <code>{m.tag}</code>
                        </span>
                      </>
                    )}
                    <span className="text-xs text-text-muted">·</span>
                    <span className="text-xs text-text-muted">{m.meta}</span>
                    {m.isInstalled && (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <CheckCircle2 className="h-3.5 w-3.5" /> installed
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted">{m.blurb}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {m.isInstalled ? (
                    <Button
                      variant={selected ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => onPick(m.tag)}
                      disabled={selected}
                    >
                      {selected ? "In use" : "Use this"}
                    </Button>
                  ) : p ? (
                    <Button variant="secondary" size="sm" disabled>
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      {pct !== undefined ? `${pct}%` : "Starting…"}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => handlePull(m.tag)}>
                      <Download className="mr-1 h-4 w-4" />
                      Download
                    </Button>
                  )}
                </div>
              </div>
              {p && pct !== undefined && <ProgressBar value={pct} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
