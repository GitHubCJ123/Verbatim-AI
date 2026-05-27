import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Mic, Square, Sparkles, Loader2, ArrowLeft } from "lucide-react";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Card, CardContent } from "../components/ui/Card";
import { Switch } from "../components/ui/Switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/Select";
import { HotkeyRecorder } from "../components/settings/HotkeyRecorder";
import { Badge } from "../components/ui/Badge";
import { toast } from "../components/ui/Toast";
import { useModes, loadVocabulary } from "../lib/store/useModes";
import {
  getActiveProvider,
  WHISPER_TIERS,
  listOllamaModels,
  pingOllama,
  getOllamaHost,
  type OllamaModelInfo,
} from "../lib/ai";
import { estimateTokens } from "../lib/ai/promptBuilder";
import { startRecording, type AudioController } from "../lib/audio";
import { Waveform } from "../components/recording/Waveform";
import type {
  Mode,
  OutputStyle,
  TranscribeProviderKind,
  WhisperTierKind,
  CleanupProviderKind,
} from "../types/mode";

const ICON_OPTIONS = [
  "Sparkles",
  "Mail",
  "MessageSquare",
  "Code",
  "FileText",
  "Languages",
  "Mic",
  "Wand2",
  "Send",
  "Zap",
];

export default function ModeEditor() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = params.get("id");

  const modes = useModes((s) => s.modes);
  const update = useModes((s) => s.update);

  const mode = useMemo(() => modes.find((m) => m.id === id) ?? null, [modes, id]);
  const [draft, setDraft] = useState<Mode | null>(mode);

  useEffect(() => {
    setDraft(mode);
  }, [mode]);

  const set = <K extends keyof Mode>(key: K, value: Mode[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  if (!draft) {
    return (
      <PageContainer>
        <PageHeader
          title="Mode not found"
          description="The mode you're looking for no longer exists."
          actions={
            <Button variant="secondary" size="sm" onClick={() => navigate("/modes")}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Modes
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const dirty = mode && JSON.stringify(mode) !== JSON.stringify(draft);

  const save = () => {
    if (!draft) return;
    update(draft.id, draft);
    toast.success("Mode saved");
  };

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title={draft.isBuiltin ? `${draft.name} (built-in)` : draft.name}
        description={draft.description || "Configure the cleanup prompt, output, and hotkey."}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate("/modes")}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={save} disabled={!dirty}>
              {dirty ? "Save changes" : "Saved"}
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-6">
        <FormColumn draft={draft} set={set} />
        <TestColumn draft={draft} />
      </div>
    </PageContainer>
  );
}

function FormColumn({
  draft,
  set,
}: {
  draft: Mode;
  set: <K extends keyof Mode>(k: K, v: Mode[K]) => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-5 pt-5">
        <Row label="Name">
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </Row>

        <Row label="Icon">
          <Select value={draft.icon} onValueChange={(v) => set("icon", v)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ICON_OPTIONS.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label="Description">
          <Input value={draft.description} onChange={(e) => set("description", e.target.value)} />
        </Row>

        <Row
          label="System prompt"
          help={`~${estimateTokens(draft.systemPrompt)} tokens`}
        >
          <Textarea
            rows={9}
            className="font-mono text-xs"
            value={draft.systemPrompt}
            onChange={(e) => set("systemPrompt", e.target.value)}
          />
        </Row>

        <div className="grid grid-cols-2 gap-3">
          <Row label="Language">
            <Input
              value={draft.language}
              onChange={(e) => set("language", e.target.value)}
              placeholder="auto"
            />
          </Row>
          <Row label="Translate to">
            <Input
              value={draft.targetLanguage ?? ""}
              onChange={(e) => set("targetLanguage", e.target.value || null)}
              placeholder="(no translation)"
            />
          </Row>
        </div>

        <Row label="Output">
          <Select
            value={draft.outputStyle}
            onValueChange={(v) => set("outputStyle", v as OutputStyle)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paste">Auto-paste</SelectItem>
              <SelectItem value="review">Review before pasting</SelectItem>
            </SelectContent>
          </Select>
        </Row>

        <Row label="Mode hotkey" help="Optional — overrides global when this mode is set">
          <HotkeyRecorder
            value={draft.hotkey ?? ""}
            onChange={(spec) => set("hotkey", spec)}
          />
        </Row>

        <ToggleRow
          title="Push-to-talk"
          description="Hold to record. Off = tap to toggle."
          checked={draft.pushToTalk}
          onChange={(v) => set("pushToTalk", v)}
        />

        <ToggleRow
          title="Save to history"
          description="Keep cleaned transcripts in your history."
          checked={draft.saveHistory}
          onChange={(v) => set("saveHistory", v)}
        />

        <ToggleRow
          title="Skip AI cleanup"
          description="Paste the raw transcript instantly, no polishing pass. Fastest path. Vocabulary replacements still run."
          checked={draft.skipCleanup}
          onChange={(v) => set("skipCleanup", v)}
        />

        <AiOverridesSection draft={draft} set={set} />
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="block text-xs font-medium text-text-secondary">{label}</label>
        {help && <span className="text-[10px] text-text-muted">{help}</span>}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-elevated px-4 py-3">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// ─── Live test column ──────────────────────────────────────────────────

type TestState = "idle" | "recording" | "processing" | "polishing" | "done" | "error";

function TestColumn({ draft }: { draft: Mode }) {
  const [state, setState] = useState<TestState>("idle");
  const [raw, setRaw] = useState("");
  const [cleaned, setCleaned] = useState("");
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AudioController | null>(null);

  const start = async () => {
    setError(null);
    setRaw("");
    setCleaned("");
    try {
      controllerRef.current = await startRecording({
        onError: (e) => {
          setError(e.message);
          setState("error");
        },
      });
      setState("recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  const stop = async () => {
    const c = controllerRef.current;
    controllerRef.current = null;
    if (!c) {
      setState("idle");
      return;
    }
    setState("processing");
    const result = await c.stop();
    if (!result) {
      setState("idle");
      return;
    }

    const provider = getActiveProvider(draft);
    if (!provider) {
      setError("Configure Azure in Settings → AI first.");
      setState("error");
      return;
    }

    const vocab = loadVocabulary().map((t) => t.term);
    try {
      const transcript = await provider.transcribe({
        audio: result.blob,
        language: draft.language || "auto",
        vocabularyHints: vocab,
      });
      setRaw(transcript.text);

      setState("polishing");
      let acc = "";
      for await (const chunk of provider.cleanup({
        rawText: transcript.text,
        systemPrompt: draft.systemPrompt,
        modeName: draft.name,
        modeDescription: draft.description,
        vocabulary: vocab,
        targetLanguage: draft.targetLanguage ?? undefined,
      })) {
        acc += chunk;
        setCleaned(acc);
      }
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  const busy = state === "recording" || state === "processing" || state === "polishing";
  const getBars = () => controllerRef.current?.getBars(32) ?? new Array(32).fill(0);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 pt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent-start" />
              <div className="text-sm font-medium">Test this mode</div>
            </div>
            {state !== "idle" && (
              <Badge variant={state === "error" ? "danger" : "accent"}>
                {labelFor(state)}
              </Badge>
            )}
          </div>

          <div className="flex h-16 items-center gap-3 rounded-md border border-border-subtle bg-bg-base px-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-gradient-to-br from-accent-start to-accent-end text-white">
              <Mic className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <div className="flex-1">
              {state === "recording" ? (
                <Waveform getBars={getBars} className="h-10 w-full" />
              ) : busy ? (
                <div className="text-xs text-text-secondary">{labelFor(state)}…</div>
              ) : (
                <div className="text-xs text-text-muted">
                  Press Record and read aloud. Release Stop to run transcribe + cleanup.
                </div>
              )}
            </div>
            <div className="shrink-0">
              {state === "recording" ? (
                <Button variant="danger" size="sm" onClick={stop}>
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={start}
                  disabled={busy}
                >
                  {state === "processing" || state === "polishing" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mic className="h-3.5 w-3.5" />
                  )}
                  Record
                </Button>
              )}
            </div>
          </div>

          {error && <div className="text-xs text-danger">{error}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-5 pt-5">
          <div className="text-xs font-medium uppercase tracking-wide text-text-muted">Raw</div>
          <div className="min-h-[60px] whitespace-pre-wrap text-sm text-text-secondary">
            {raw || <span className="text-text-muted">(no transcript yet)</span>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-3 p-5 pt-5">
          <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Cleaned with {draft.name}
          </div>
          <div className="min-h-[80px] whitespace-pre-wrap text-sm text-text-primary">
            {cleaned || <span className="text-text-muted">(no output yet)</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function labelFor(s: TestState): string {
  switch (s) {
    case "recording":
      return "Recording";
    case "processing":
      return "Transcribing";
    case "polishing":
      return "Polishing";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return "";
  }
}

// ─── Per-Mode AI overrides ────────────────────────────────────────────

const INHERIT = "__inherit__";

function AiOverridesSection({
  draft,
  set,
}: {
  draft: Mode;
  set: <K extends keyof Mode>(k: K, v: Mode[K]) => void;
}) {
  const [open, setOpen] = useState(
    draft.transcribeProviderOverride !== null ||
      draft.whisperTierOverride !== null ||
      draft.cleanupProviderOverride !== null ||
      draft.ollamaModelOverride !== null,
  );
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ollamaReachable, setOllamaReachable] = useState<boolean | null>(null);

  // Refresh Ollama models if the cleanup override is local-ollama. We
  // need a populated dropdown to pick from; without it the user can't
  // override the model meaningfully.
  useEffect(() => {
    if (draft.cleanupProviderOverride !== "local-ollama") return;
    let cancelled = false;
    (async () => {
      const host = getOllamaHost();
      const ping = await pingOllama(host);
      const reachable = ping.kind === "ok";
      if (cancelled) return;
      setOllamaReachable(reachable);
      if (!reachable) {
        setOllamaModels([]);
        return;
      }
      try {
        const list = await listOllamaModels(host);
        if (!cancelled) setOllamaModels(list);
      } catch {
        if (!cancelled) setOllamaModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.cleanupProviderOverride]);

  return (
    <div className="rounded-md border border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <div className="text-sm font-medium">AI overrides (advanced)</div>
          <div className="text-xs text-text-muted">
            Pin this Mode to a specific transcription / cleanup model. Leave on "Use global default" to inherit Settings → AI model.
          </div>
        </div>
        <span className="text-xs text-text-muted">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-border-subtle p-4">
          <Row label="Transcribe provider">
            <Select
              value={draft.transcribeProviderOverride ?? INHERIT}
              onValueChange={(v) =>
                set(
                  "transcribeProviderOverride",
                  v === INHERIT ? null : (v as TranscribeProviderKind),
                )
              }
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>Use global default</SelectItem>
                <SelectItem value="cloud">Cloud (Azure Whisper)</SelectItem>
                <SelectItem value="local-whisper">Local Whisper</SelectItem>
                <SelectItem value="local-parakeet">Parakeet TDT</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          {draft.transcribeProviderOverride === "local-whisper" && (
            <Row label="Whisper tier">
              <Select
                value={draft.whisperTierOverride ?? INHERIT}
                onValueChange={(v) =>
                  set(
                    "whisperTierOverride",
                    v === INHERIT ? null : (v as WhisperTierKind),
                  )
                }
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>Use global tier</SelectItem>
                  {WHISPER_TIERS.map((t) => (
                    <SelectItem key={t.tier} value={t.tier}>
                      {t.label} · {t.tier}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}

          <Row label="Cleanup provider">
            <Select
              value={draft.cleanupProviderOverride ?? INHERIT}
              onValueChange={(v) =>
                set(
                  "cleanupProviderOverride",
                  v === INHERIT ? null : (v as CleanupProviderKind),
                )
              }
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>Use global default</SelectItem>
                <SelectItem value="cloud">Cloud (Azure GPT)</SelectItem>
                <SelectItem value="local-ollama">Local (Ollama)</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          {draft.cleanupProviderOverride === "local-ollama" && (
            <Row label="Ollama model">
              {ollamaReachable === false ? (
                <div className="text-xs text-text-muted">
                  Ollama not reachable. Configure it in Settings → AI model first.
                </div>
              ) : ollamaModels.length === 0 ? (
                <div className="text-xs text-text-muted">
                  No models pulled. Pull one from Settings → AI model.
                </div>
              ) : (
                <Select
                  value={draft.ollamaModelOverride ?? INHERIT}
                  onValueChange={(v) =>
                    set("ollamaModelOverride", v === INHERIT ? null : v)
                  }
                >
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Use global model</SelectItem>
                    {ollamaModels.map((m) => (
                      <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Row>
          )}
        </div>
      )}
    </div>
  );
}
