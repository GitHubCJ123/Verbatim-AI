import { useEffect, useState } from "react";
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
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/Select";
import { HotkeyRecorder } from "../components/settings/HotkeyRecorder";
import { applyHotkey, loadHotkeyConfig, saveHotkeyConfig } from "../lib/hotkey";
import {
  isAutostartEnabled,
  loadPreferences,
  setAutostart,
  setNotifyOnSuccess,
} from "../lib/preferences";
import { useOnboarding } from "../lib/store/useOnboarding";
import {
  getActiveProvider,
  getAiProviderKind,
  setAiProviderKind,
  getLocalWhisperTier,
  setLocalWhisperTier,
  listLocalModels,
  downloadLocalModel,
  deleteLocalModel,
  isWhisperRuntimeInstalled,
  installWhisperRuntime,
  WHISPER_TIERS,
  type AiProviderKind,
  type LocalModelInfo,
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
  type CleanupProviderKind,
  type OllamaModelInfo,
  type SuggestedModel,
} from "../lib/ai";
import { useTheme, type Theme } from "../lib/theme";
import { osName, clipboardHistoryHint } from "../lib/os";
import {
  loadOverlayPosition,
  setOverlayPosition,
  type OverlayPosition,
  isClipboardRestoreEnabled,
  setClipboardRestore,
  isHistoryDisabled,
  setHistoryDisabled,
} from "../lib/preferences";

interface RowProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function SettingRow({ title, description, children }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border-subtle py-4 last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ThemeSelect() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.set);
  return (
    <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
      <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
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
  );
}

function ClipboardRestoreSwitch() {
  const [on, setOn] = useState(isClipboardRestoreEnabled());
  return (
    <Switch
      checked={on}
      onCheckedChange={(v) => {
        setClipboardRestore(v);
        setOn(v);
      }}
    />
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

export default function Settings() {
  const [hotkey, setHotkey] = useState(() => loadHotkeyConfig());
  const [autostart, setAutostartState] = useState(false);
  const [notifyOnSuccess, setNotifyState] = useState(() => loadPreferences().notifyOnSuccess);

  useEffect(() => {
    saveHotkeyConfig(hotkey);
  }, [hotkey]);

  useEffect(() => {
    void isAutostartEnabled().then(setAutostartState);
  }, []);

  const handleHotkeyChange = async (spec: string) => {
    try {
      await applyHotkey(spec);
      setHotkey((h) => ({ ...h, spec }));
      toast.success("Hotkey updated", { description: `Now using ${spec}` });
    } catch (e) {
      toast.error("Couldn't register that shortcut", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <PageContainer>
      <PageHeader title="Settings" description="Configure Verbatim AI to fit your workflow." />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="model">AI model</TabsTrigger>
          <TabsTrigger value="recording">Recording</TabsTrigger>
          <TabsTrigger value="overlay">Overlay</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Launch at startup" description={`Open Verbatim AI when ${osName()} starts.`}>
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
                title="Notify on transcribe"
                description="Show a system notification after each successful transcription."
              >
                <Switch
                  checked={notifyOnSuccess}
                  onCheckedChange={(v) => {
                    setNotifyOnSuccess(v);
                    setNotifyState(v);
                  }}
                />
              </SettingRow>
              <SettingRow title="Theme" description={`Match ${osName()} or pick light/dark.`}>
                <ThemeSelect />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="model">
          <ModelTab />
        </TabsContent>

        <TabsContent value="recording">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Global hotkey" description="Hold to dictate from anywhere.">
                <HotkeyRecorder value={hotkey.spec} onChange={handleHotkeyChange} />
              </SettingRow>
              <SettingRow title="Push-to-talk" description="Hold to record. Off = tap to toggle.">
                <Switch
                  checked={hotkey.pushToTalk}
                  onCheckedChange={(checked) =>
                    setHotkey((h) => ({ ...h, pushToTalk: checked }))
                  }
                />
              </SettingRow>
              <SettingRow title="Noise suppression" description="Filter background noise during recording.">
                <Switch defaultChecked />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="overlay">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Position" description="Where the recording pill appears.">
                <OverlayPositionSelect />
              </SettingRow>
              <SettingRow
                title="Restore clipboard after paste"
                description={`When on, Verbatim AI remembers whatever you had on the clipboard before dictating, pastes the cleaned text, then puts your original content back ~1 second later. Off by default — ${clipboardHistoryHint()}`}
              >
                <ClipboardRestoreSwitch />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow
                title="Save transcription history"
                description="When off, transcripts are not saved anywhere — your dictation still works and pastes/reviews as normal, but nothing is written to the History page. Overrides the per-mode setting."
              >
                <HistoryDisabledSwitch />
              </SettingRow>
              <SettingRow title="Anonymous telemetry" description="Help improve Verbatim AI. Never your transcript content.">
                <Switch />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="advanced">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Log level" description="Verbosity of log files.">
                <Select defaultValue="info">
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="error">Error</SelectItem>
                    <SelectItem value="warn">Warn</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                    <SelectItem value="debug">Debug</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                title="Test AI connection"
                description="Sends a ping to the Supabase cleanup function. Tells you whether the network path works."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    const provider = getActiveProvider();
                    if (!provider) {
                      toast.error("No provider configured");
                      return;
                    }
                    toast.info("Pinging…");
                    const h = await provider.health();
                    if (h.ok) {
                      toast.success(`Connected (${h.latencyMs ?? "?"} ms)`);
                    } else {
                      toast.error("Connection failed", {
                        description: h.message ?? "Unknown",
                        duration: 12000,
                      });
                    }
                  }}
                >
                  Test
                </Button>
              </SettingRow>
              <SettingRow
                title="Re-run onboarding"
                description="Walk through the welcome flow again to reconfigure tone presets."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    useOnboarding.getState().reset();
                    window.location.reload();
                  }}
                >
                  Restart
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
  const [selectedTier, setSelectedTier] = useState<WhisperTier>(getLocalWhisperTier());
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [runtimeInstalled, setRuntimeInstalled] = useState<boolean>(false);
  const [installingRuntime, setInstallingRuntime] = useState<{ downloaded: number; total: number } | null>(null);
  const [downloading, setDownloading] = useState<Record<WhisperTier, { downloaded: number; total: number } | undefined>>(
    {} as Record<WhisperTier, { downloaded: number; total: number } | undefined>,
  );

  const refresh = async () => {
    try {
      const [m, rt] = await Promise.all([listLocalModels(), isWhisperRuntimeInstalled()]);
      setModels(m);
      setRuntimeInstalled(rt);
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
        setDownloading((d) => ({ ...d, [e.payload.tier]: { downloaded: e.payload.downloaded, total: e.payload.total } }));
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

  const handleProviderChange = (next: AiProviderKind) => {
    setAiProviderKind(next);
    setKind(next);
    toast.success(next === "cloud" ? "Using cloud (Azure Whisper)" : "Using local Whisper");
  };

  const handleTierChange = (tier: WhisperTier) => {
    setLocalWhisperTier(tier);
    setSelectedTier(tier);
  };

  const handleDownload = async (tier: WhisperTier) => {
    setDownloading((d) => ({ ...d, [tier]: { downloaded: 0, total: 0 } }));
    try {
      await downloadLocalModel(tier);
      toast.success(`Downloaded ${tier}`);
    } catch (e) {
      toast.error("Download failed", { description: e instanceof Error ? e.message : String(e) });
      setDownloading((d) => ({ ...d, [tier]: undefined }));
    }
  };

  const handleDelete = async (tier: WhisperTier) => {
    try {
      await deleteLocalModel(tier);
      toast.success(`Removed ${tier}`);
      void refresh();
    } catch (e) {
      toast.error("Couldn't remove model", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleInstallRuntime = async () => {
    setInstallingRuntime({ downloaded: 0, total: 0 });
    try {
      await installWhisperRuntime();
      toast.success("whisper.cpp runtime installed");
    } catch (e) {
      toast.error("Couldn't install runtime", { description: e instanceof Error ? e.message : String(e) });
      setInstallingRuntime(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-5 pt-5">
          <SettingRow
            title="Transcription provider"
            description="Where speech-to-text runs. Cloud is the default. Local keeps audio on this machine and works offline once a model is downloaded."
          >
            <Select value={kind} onValueChange={(v) => handleProviderChange(v as AiProviderKind)}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cloud">Cloud (Azure Whisper)</SelectItem>
                <SelectItem value="local-whisper">Local Whisper</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <div className="pt-3 text-xs text-text-muted">
            Cloud option may be removed in a future release. The cleanup step (tone polish) is configured separately below.
          </div>
        </CardContent>
      </Card>

      {kind === "local-whisper" && (
        <Card>
          <CardContent className="p-5 pt-5">
            <div className="mb-3 text-sm font-medium">whisper.cpp runtime</div>
            <div className="mb-4 text-xs text-text-muted">
              The runtime is the small executable (~5 MB) that actually runs Whisper on your machine. Install it once.
            </div>
            <div className="flex items-center justify-between rounded-md border border-border-subtle p-3">
              <div className="flex flex-col gap-0.5">
                <div className="text-sm">
                  {runtimeInstalled ? (
                    <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                      <CheckCircle2 className="h-4 w-4" /> Installed
                    </span>
                  ) : (
                    <span className="text-text-muted">Not installed</span>
                  )}
                </div>
                <div className="text-xs text-text-muted">whisper.cpp v1.8.4 · CUDA build (uses your NVIDIA GPU)</div>
              </div>
              {runtimeInstalled ? (
                <Button variant="ghost" size="sm" onClick={handleInstallRuntime} title="Reinstall">Reinstall</Button>
              ) : installingRuntime ? (
                <Button variant="secondary" size="sm" disabled>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  {installingRuntime.total > 0
                    ? `${Math.round((installingRuntime.downloaded / installingRuntime.total) * 100)}%`
                    : "Starting…"}
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={handleInstallRuntime}>
                  <Download className="mr-1 h-4 w-4" /> Install runtime
                </Button>
              )}
            </div>
            {installingRuntime && installingRuntime.total > 0 && (
              <div className="pt-3">
                <ProgressBar value={Math.round((installingRuntime.downloaded / installingRuntime.total) * 100)} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {kind === "local-whisper" && (
        <Card>
          <CardContent className="p-5 pt-5">
            <div className="mb-3 text-sm font-medium">Local Whisper models</div>
            <div className="mb-4 text-xs text-text-muted">
              Pick a tier based on your machine. Larger = more accurate, slower. Models download from Hugging Face on demand.
            </div>
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
                      isSelected
                        ? "border-accent bg-accent/5"
                        : "border-border-subtle"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{meta.label}</span>
                          <span className="text-xs text-text-muted">·</span>
                          <span className="text-xs text-text-muted">{meta.tier}</span>
                          <span className="text-xs text-text-muted">·</span>
                          <span className="text-xs text-text-muted">{formatSize(meta.approxSizeMB)}</span>
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
                          <Button variant="secondary" size="sm" onClick={() => handleDownload(meta.tier)}>
                            <Download className="mr-1 h-4 w-4" />
                            Download
                          </Button>
                        )}
                      </div>
                    </div>
                    {dl && dlPct !== undefined && (
                      <ProgressBar value={dlPct} />
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

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

function CleanupSection() {
  const [kind, setKind] = useState<CleanupProviderKind>(getCleanupProviderKind());
  const [host, setHostState] = useState<string>(getOllamaHost());
  const [model, setModelState] = useState<string>(getOllamaModel());
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const ok = await pingOllama(host);
      setReachable(ok);
      if (ok) {
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
      setReachable(false);
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

  const handleKind = (next: CleanupProviderKind) => {
    setCleanupProviderKind(next);
    setKind(next);
    toast.success(
      next === "cloud" ? "Cleanup: using cloud" : "Cleanup: using local Ollama",
    );
  };

  return (
    <>
      <Card>
        <CardContent className="p-5 pt-5">
          <SettingRow
            title="Cleanup provider"
            description="Where tone polish and grammar fix runs. Independent from transcription — you can mix and match."
          >
            <Select value={kind} onValueChange={(v) => handleKind(v as CleanupProviderKind)}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cloud">Cloud (Azure GPT)</SelectItem>
                <SelectItem value="local-ollama">Local (Ollama)</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </CardContent>
      </Card>

      {kind === "local-ollama" && (
        <Card>
          <CardContent className="p-5 pt-5">
            <div className="mb-3 text-sm font-medium">Ollama</div>
            <div className="mb-4 text-xs text-text-muted">
              Verbatim AI talks to a local Ollama server. Install Ollama once from{" "}
              <a
                href="https://ollama.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-start hover:underline"
              >
                ollama.com <ExternalLink className="h-3 w-3" />
              </a>{" "}
              and pull a model in a terminal: <code className="text-text-primary">ollama pull qwen2.5:7b</code>.
            </div>

            <SettingRow
              title="Status"
              description="Whether Ollama is currently reachable at the configured host."
            >
              {reachable === null ? (
                <span className="text-xs text-text-muted">—</span>
              ) : reachable ? (
                <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Connected
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

            <SettingRow
              title="Model"
              description="Pulled models on this Ollama instance. Pull more from a terminal."
            >
              {reachable === false ? (
                <span className="text-xs text-text-muted">Connect first</span>
              ) : models.length === 0 ? (
                <span className="text-xs text-text-muted">No models pulled</span>
              ) : (
                <Select
                  value={model || undefined}
                  onValueChange={(v) => {
                    setOllamaModel(v);
                    setModelState(v);
                  }}
                >
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder="Pick a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {m.name} · {formatBytes(m.sizeBytes)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </SettingRow>

            {reachable === false && (
              <div className="mt-3 rounded-md border border-border-subtle bg-bg-elevated/40 p-3 text-xs text-text-muted">
                Couldn't reach Ollama at <code className="text-text-primary">{host}</code>.
                Make sure it's installed and running. On {osName()} it should auto-start after install.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {kind === "local-ollama" && reachable && (
        <SuggestedOllamaList
          host={host}
          installedNames={new Set(models.map((m) => m.name))}
          currentModel={model}
          onPulled={refresh}
          onPick={(name) => {
            setOllamaModel(name);
            setModelState(name);
          }}
        />
      )}
    </>
  );
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function SuggestedOllamaList({
  host,
  installedNames,
  currentModel,
  onPulled,
  onPick,
}: {
  host: string;
  installedNames: Set<string>;
  currentModel: string;
  onPulled: () => void | Promise<void>;
  onPick: (name: string) => void;
}) {
  const [pulling, setPulling] = useState<Record<string, { completed: number; total: number; status: string } | undefined>>(
    {} as Record<string, { completed: number; total: number; status: string } | undefined>,
  );

  const handlePull = async (m: SuggestedModel) => {
    setPulling((p) => ({ ...p, [m.tag]: { completed: 0, total: 0, status: "starting" } }));
    try {
      await pullOllamaModel(m.tag, host, (prog) => {
        setPulling((p) => ({
          ...p,
          [m.tag]: {
            completed: prog.completed ?? 0,
            total: prog.total ?? 0,
            status: prog.status,
          },
        }));
      });
      toast.success(`Pulled ${m.tag}`);
      await onPulled();
    } catch (e) {
      toast.error("Pull failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPulling((p) => ({ ...p, [m.tag]: undefined }));
    }
  };

  return (
    <Card>
      <CardContent className="p-5 pt-5">
        <div className="mb-3 text-sm font-medium">Suggested models</div>
        <div className="mb-4 text-xs text-text-muted">
          Pull any of these directly into Ollama from here. You can also pull anything else with{" "}
          <code className="text-text-primary">ollama pull &lt;tag&gt;</code> in a terminal.
        </div>
        <div className="flex flex-col gap-2">
          {SUGGESTED_OLLAMA_MODELS.map((m) => {
            const installed = installedNames.has(m.tag);
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
                      <span className="text-xs text-text-muted">·</span>
                      <span className="text-xs text-text-muted"><code>{m.tag}</code></span>
                      <span className="text-xs text-text-muted">·</span>
                      <span className="text-xs text-text-muted">
                        {formatMB(m.approxDiskMB)} disk · ~{formatMB(m.approxVramMB)} VRAM
                      </span>
                      {installed && (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                          <CheckCircle2 className="h-3.5 w-3.5" /> installed
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-muted">{m.blurb}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {installed ? (
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
                        {pct !== undefined ? `${pct}%` : p.status}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => handlePull(m)}>
                        <Download className="mr-1 h-4 w-4" /> Download
                      </Button>
                    )}
                  </div>
                </div>
                {p && pct !== undefined && <ProgressBar value={pct} />}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
