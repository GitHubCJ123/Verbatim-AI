import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronRight, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "../lib/utils";
import { toast } from "../components/ui/Toast";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/Tabs";
import { Card, CardContent } from "../components/ui/Card";
import { Switch } from "../components/ui/Switch";
import { Button } from "../components/ui/Button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../components/ui/Select";
import { HotkeyRecorder } from "../components/settings/HotkeyRecorder";
import { SpeechModelPicker } from "../components/settings/SpeechModelPicker";
import { CleanupModelPicker } from "../components/settings/CleanupModelPicker";
import { DiagnosticsSettings } from "../components/settings/DiagnosticsSettings";
import {
  hotkeyDisplayParts,
  isForcedHoldSpec,
  loadHotkeyConfig,
  saveHotkeyConfig,
} from "../lib/hotkey";
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
  prewarmEngines,
  getAiProviderKind,
  setAiProviderKind,
  getLocalWhisperTier,
  setLocalWhisperTier,
  listCustomWhisperModels,
  rescanLocalModels,
  deleteLocalModel,
  getWhisperComputePreference,
  setWhisperComputePreference,
  getActiveWhisperRuntimeVariant,
  whisperComputePreferenceLabel,
  whisperRuntimeVariantLabel,
  type AiProviderKind,
  type CustomModelInfo,
  type WhisperComputePreference,
  type WhisperModelId,
  type WhisperRuntimeVariant,
  getCleanupProviderKind,
  setCleanupProviderKind,
  type CleanupProviderKind,
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
  /** "start" for children whose height can grow (e.g. status/warning
   *  panels), so the label doesn't get centered against the full height. */
  align?: "center" | "start";
}

function SettingRow({ title, description, children, id, align = "center" }: RowProps) {
  return (
    <div
      id={id ? `setting-${id}` : undefined}
      className={cn(
        "flex scroll-mt-24 justify-between gap-6 rounded-md border-b border-border-subtle py-4 transition-shadow last:border-b-0",
        align === "start" ? "items-start" : "items-center",
      )}
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

  const handleHotkeyChange = (spec: string, registered: boolean) => {
    // The recorder only publishes accepted bindings (or an explicitly
    // pending Input Monitoring modifier preset). Do not register twice.
    setHotkey((h) => ({ ...h, spec, pushToTalk: h.pushToTalk || isForcedHoldSpec(spec) }));
    if (registered) {
      toast.success("Hotkey updated", {
        description: `Now using ${hotkeyDisplayParts(spec).join(" ")}`,
      });
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
                align="start"
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
              <DiagnosticsSettings />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="advanced">
          <Card>
            <CardContent className="p-5 pt-5">
              <RecordingEngineRow />
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
                description="Show the WebView2 dev tools for the main window. Use the Console tab to see app logs (transcription, updates, etc)."
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

function ModelTab() {
  const [kind, setKind] = useState<AiProviderKind>(getAiProviderKind());
  const [selectedTier, setSelectedTier] = useState<WhisperModelId>(getLocalWhisperTier());
  const [computePreference, setComputePreference] = useState<WhisperComputePreference>(
    getWhisperComputePreference(),
  );
  const [activeRuntime, setActiveRuntime] = useState<WhisperRuntimeVariant | null>(null);
  const [customModels, setCustomModels] = useState<CustomModelInfo[]>([]);
  const [rescanning, setRescanning] = useState(false);
  const [transcriptionTest, setTranscriptionTest] = useState<ProviderTestStatus | null>(null);
  const [testingTranscription, setTestingTranscription] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);

  const refresh = async () => {
    try {
      const [custom, active] = await Promise.all([
        listCustomWhisperModels(),
        getActiveWhisperRuntimeVariant(),
      ]);
      setCustomModels(custom);
      setActiveRuntime(active);
    } catch (e) {
      toast.error("Couldn't read custom models", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleProviderChange = (next: AiProviderKind) => {
    setAiProviderKind(next);
    setKind(next);
    setTranscriptionTest(null);
    setPickerKey((k) => k + 1);
  };

  // The model list changed the engine/model: resync this view.
  const onPickerChange = () => {
    setKind(getAiProviderKind());
    setSelectedTier(getLocalWhisperTier());
    setTranscriptionTest(null);
    void refresh();
  };

  const handleTierChange = (tier: WhisperModelId) => {
    setLocalWhisperTier(tier);
    setSelectedTier(tier);
  };

  const handleUseCustom = (id: WhisperModelId) => {
    handleTierChange(id);
    setAiProviderKind("local-whisper");
    setKind("local-whisper");
    setPickerKey((k) => k + 1);
    prewarmEngines(null);
  };

  const getLocalSpeechKind = (): AiProviderKind => (kind === "cloud" ? "local-parakeet" : kind);

  const handleRescan = async () => {
    setRescanning(true);
    try {
      const found = await rescanLocalModels();
      setCustomModels(found);
      toast.success(
        found.length === 1 ? "Found 1 custom model" : `Found ${found.length} custom models`,
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
    void refresh();
  };

  const handleDelete = async (id: WhisperModelId) => {
    try {
      await deleteLocalModel(id);
      if (selectedTier === id) handleTierChange("turbo");
      toast.success(`Removed ${id.replace("custom:", "")}`);
      setPickerKey((k) => k + 1);
      void refresh();
    } catch (e) {
      toast.error("Couldn't remove model", {
        description: e instanceof Error ? e.message : String(e),
      });
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
            title="Speech model"
            description="Start with a language-compatible recommendation, or keep your current model. The complete catalog is under Advanced. Downloads and model changes happen only when you choose them."
          />
          <div id="setting-speech-model" className="mt-3 scroll-mt-24">
            <SpeechModelPicker key={pickerKey} onChange={onPickerChange} />
          </div>

          <ProviderTestControl
            id="test-transcription"
            label="Test transcription"
            testing={testingTranscription}
            status={transcriptionTest}
            onTest={handleTestTranscription}
          />

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="mt-4 inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary"
            aria-expanded={showAdvanced}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
            />
            Advanced: compute device, custom model files
          </button>

          {showAdvanced && (
            <div className="mt-3 border-t border-border-subtle pt-3">
              {CLOUD_FEATURES_ENABLED && (
                <SettingRow
                  id="transcription-provider"
                  title="Runs on"
                  description="Cloud sends audio to the Verbatim cloud; the models above run on this computer."
                >
                  <Select
                    value={kind === "cloud" ? "cloud" : "local"}
                    onValueChange={(v) =>
                      handleProviderChange(v === "cloud" ? "cloud" : getLocalSpeechKind())
                    }
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">This computer</SelectItem>
                      <SelectItem value="cloud">Cloud</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
              )}

              <SettingRow
                title="Compute device"
                description={`For Whisper models. Auto currently uses ${
                  activeRuntime
                    ? whisperRuntimeVariantLabel(activeRuntime)
                    : "the best available device"
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

              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">Custom model files</div>
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
                  Bring your own Whisper-compatible model: drop a <code>.bin</code> or{" "}
                  <code>.gguf</code> file into the whisper-models folder, then Rescan.
                </div>
                {customModels.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border-subtle p-3 text-xs text-text-muted">
                    No custom models found.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {customModels.map((cm) => {
                      const isSelected = kind === "local-whisper" && selectedTier === cm.id;
                      return (
                        <div
                          key={cm.id}
                          className={`flex items-start justify-between gap-3 rounded-md border p-3 ${
                            isSelected ? "border-accent bg-accent/5" : "border-border-subtle"
                          }`}
                        >
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{cm.displayName}</span>
                              <span className="text-xs text-text-muted">·</span>
                              <span className="text-xs text-text-muted">
                                {formatBytes(cm.sizeBytes)}
                              </span>
                            </div>
                            <div className="truncate text-xs text-text-muted">{cm.fileName}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              variant={isSelected ? "primary" : "secondary"}
                              size="sm"
                              onClick={() => handleUseCustom(cm.id)}
                              disabled={isSelected}
                            >
                              {isSelected ? "In use" : "Use this"}
                            </Button>
                            {!isSelected && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDelete(cm.id)}
                                title="Remove model file"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <CleanupSection />
    </div>
  );
}

// --------------------------------------------------------------------------
// AI polish (cleanup) section
// --------------------------------------------------------------------------

function formatBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  return `${b} B`;
}

function CleanupSection() {
  const [enabled, setEnabled] = useState(() => !isAiImproveDisabled());
  const [where, setWhere] = useState<CleanupProviderKind>(getCleanupProviderKind);
  const [cleanupTest, setCleanupTest] = useState<ProviderTestStatus | null>(null);
  const [testingCleanup, setTestingCleanup] = useState(false);

  const handleEnabled = (on: boolean) => {
    setAiImproveDisabled(!on);
    setEnabled(on);
    setCleanupTest(null);
  };

  const handleWhere = (next: CleanupProviderKind) => {
    setCleanupProviderKind(next);
    setWhere(next);
    setCleanupTest(null);
  };

  const handleTestCleanup = async () => {
    setTestingCleanup(true);
    setCleanupTest(null);
    try {
      if (!enabled) {
        setCleanupTest(
          providerTestStatus("cleanup", {
            ok: true,
            message: "AI polish is off. Raw transcript mode is ready.",
          }),
        );
        return;
      }
      setCleanupTest(providerTestStatus("cleanup", await testCleanupProvider()));
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

  return (
    <Card>
      <CardContent className="p-5 pt-5">
        <StageHeader
          eyebrow="Step 2 · optional"
          title="AI polish"
          description="Optional local cleanup for fillers, self-corrections, numbers and punctuation. Keep your current model or choose the recommendation; other polish models remain under Advanced."
        />
        <SettingRow
          id="cleanup-provider"
          title="Improve with AI"
          description="Turn off to paste exactly what you said, with no extra delay. Vocabulary replacements still apply."
        >
          <Switch checked={enabled} onCheckedChange={handleEnabled} />
        </SettingRow>

        {enabled && CLOUD_FEATURES_ENABLED && (
          <SettingRow
            id="cleanup-location"
            title="Runs on"
            description="Where the polish step runs."
          >
            <Select value={where} onValueChange={(v) => handleWhere(v as CleanupProviderKind)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">This computer</SelectItem>
                <SelectItem value="cloud">Cloud</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        )}

        {enabled && where === "local" && (
          <div id="setting-cleanup-models" className="mt-4 scroll-mt-24">
            <CleanupModelPicker />
          </div>
        )}

        <ProviderTestControl
          id="test-cleanup"
          label="Test AI polish"
          testing={testingCleanup}
          status={cleanupTest}
          onTest={handleTestCleanup}
        />
      </CardContent>
    </Card>
  );
}
