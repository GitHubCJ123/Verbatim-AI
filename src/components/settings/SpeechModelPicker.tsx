/**
 * Speech model list (Settings → AI model and onboarding). Every built-in
 * model is a card with measured accuracy and speed; picking one downloads
 * whatever it needs, switches to it and warms it up.
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Globe, Languages } from "lucide-react";
import { toast } from "../ui/Toast";
import { TooltipProvider } from "../ui/Tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/Select";
import { ModelCard, type ModelCardState } from "./ModelCard";
import {
  CANARY_LANGUAGES,
  PARAKEET_LANGUAGES,
  deleteLocalModel,
  deleteParakeetModel,
  downloadLocalModel,
  downloadParakeetModel,
  getAiProviderKind,
  getLocalWhisperTier,
  getParakeetLanguage,
  getParakeetVariant,
  installParakeetRuntime,
  installWhisperRuntime,
  isParakeetRuntimeInstalled,
  isWhisperRuntimeInstalled,
  listLocalModels,
  listParakeetModels,
  prewarmEngines,
  resetWhisperEngineProbe,
  setAiProviderKind,
  setLocalWhisperTier,
  setParakeetLanguage,
  setParakeetVariant,
  type WhisperTier,
} from "../../lib/ai";
import {
  SPEECH_CHOICES,
  currentSpeechChoice,
  isSpeechChoiceInstalled,
  speechChoiceById,
  type SpeechChoice,
  type SpeechChoiceId,
  type SpeechInstallState,
} from "../../lib/ai/speechChoices";

const EMPTY_STATE: SpeechInstallState = {
  whisperRuntime: false,
  whisperTiers: {},
  parakeetRuntime: false,
  parakeetVariants: {},
};

async function readInstallState(): Promise<SpeechInstallState> {
  const [wr, wm, pr, pm] = await Promise.allSettled([
    isWhisperRuntimeInstalled(),
    listLocalModels(),
    isParakeetRuntimeInstalled(),
    listParakeetModels(),
  ]);
  return {
    whisperRuntime: wr.status === "fulfilled" && wr.value,
    whisperTiers:
      wm.status === "fulfilled"
        ? Object.fromEntries(wm.value.map((m) => [m.tier, m.installed]))
        : {},
    parakeetRuntime: pr.status === "fulfilled" && pr.value,
    parakeetVariants:
      pm.status === "fulfilled"
        ? Object.fromEntries(pm.value.map((m) => [m.variant, m.installed]))
        : {},
  };
}

function applyChoice(c: SpeechChoice) {
  if (c.engine === "local-parakeet") {
    setParakeetVariant(c.variant ?? "v3");
  } else {
    setLocalWhisperTier(c.tier ?? "turbo");
  }
  setAiProviderKind(c.engine);
  resetWhisperEngineProbe();
  // Load it now so the next dictation doesn't pay the cold model load.
  prewarmEngines(null);
}

function accuracyDetail(c: SpeechChoice) {
  return (
    <>
      {c.werPct.toFixed(1)}% word error rate on 200 LibriSpeech &ldquo;test-other&rdquo; recordings
      (harder, accented English). Lower is better.
    </>
  );
}

function speedDetail(c: SpeechChoice) {
  return (
    <>
      ~{c.secondsPer10s.toFixed(2)} s to transcribe 10 s of speech once loaded. Measured on an Apple
      M1 Pro (Whisper uses its GPU; Parakeet and Canary run on the CPU). Older or CPU-only machines
      are slower.
    </>
  );
}

export function SpeechModelPicker({ onChange }: { onChange?: () => void }) {
  const [install, setInstall] = useState<SpeechInstallState>(EMPTY_STATE);
  const [current, setCurrent] = useState<SpeechChoiceId | null>(() =>
    currentSpeechChoice(getAiProviderKind(), getLocalWhisperTier(), getParakeetVariant()),
  );
  const [language, setLanguage] = useState(getParakeetLanguage);
  const [busy, setBusy] = useState<{
    id: SpeechChoiceId;
    label: string;
    percent: number | null;
  } | null>(null);

  const refresh = async () => setInstall(await readInstallState());

  useEffect(() => {
    void readInstallState().then(setInstall);
    const update = (label: string) => (e: { payload: { downloaded: number; total: number } }) =>
      setBusy((b) =>
        b
          ? {
              ...b,
              label,
              percent:
                e.payload.total > 0
                  ? Math.round((e.payload.downloaded / e.payload.total) * 100)
                  : null,
            }
          : b,
      );
    const offs = [
      listen("local-whisper:runtime:progress", update("Setting up")),
      listen("local-whisper:download:progress", update("Downloading")),
      listen("parakeet:runtime:progress", update("Setting up")),
      listen("parakeet:download:progress", update("Downloading")),
    ];
    return () => offs.forEach((off) => void off.then((fn) => fn()));
  }, []);

  const activate = (c: SpeechChoice) => {
    applyChoice(c);
    setCurrent(c.id);
    onChange?.();
  };

  const download = async (c: SpeechChoice) => {
    if (busy) return;
    setBusy({ id: c.id, label: "Starting", percent: null });
    try {
      if (c.engine === "local-parakeet") {
        if (!install.parakeetRuntime) await installParakeetRuntime();
        await downloadParakeetModel(c.variant ?? "v3");
      } else {
        if (!install.whisperRuntime) await installWhisperRuntime();
        await downloadLocalModel((c.tier ?? "turbo") as WhisperTier);
      }
      activate(c);
      toast.success(`${c.name} is ready`, { description: "Hold your hotkey and start talking." });
    } catch (e) {
      toast.error(`Couldn't set up ${c.name}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const remove = async (c: SpeechChoice) => {
    try {
      if (c.engine === "local-parakeet") await deleteParakeetModel(c.variant ?? "v3");
      else await deleteLocalModel(c.tier ?? "turbo");
      toast.success(`Deleted ${c.name}`);
    } catch (e) {
      toast.error(`Couldn't delete ${c.name}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      void refresh();
    }
  };

  const changeLanguage = (code: string) => {
    setParakeetLanguage(code);
    setLanguage(code);
    prewarmEngines(null);
  };

  const stateOf = (c: SpeechChoice): ModelCardState => {
    if (busy?.id === c.id) return { kind: "downloading", label: busy.label, percent: busy.percent };
    if (!isSpeechChoiceInstalled(c, install)) return { kind: "available" };
    return c.id === current ? { kind: "active" } : { kind: "installed" };
  };

  const card = (c: SpeechChoice) => (
    <ModelCard
      key={c.id}
      name={c.name}
      tagline={c.tagline}
      recommended={c.recommended}
      scores={[
        { label: "Accuracy", value: c.quality, detail: accuracyDetail(c) },
        { label: "Speed", value: c.speed, detail: speedDetail(c) },
      ]}
      chips={[
        { icon: <Globe className="h-3.5 w-3.5" />, label: c.languages },
        ...(c.needsLanguage
          ? [{ icon: <Languages className="h-3.5 w-3.5" />, label: "Pick your language" }]
          : []),
      ]}
      sizeMB={c.approxSizeMB}
      state={stateOf(c)}
      disabled={!!busy && busy.id !== c.id}
      onUse={() => activate(c)}
      onDownload={() => void download(c)}
      onDelete={() => void remove(c)}
    />
  );

  const downloaded = SPEECH_CHOICES.filter((c) => isSpeechChoiceInstalled(c, install));
  const available = SPEECH_CHOICES.filter((c) => !isSpeechChoiceInstalled(c, install));
  const active = current ? speechChoiceById(current) : null;
  const canaryLanguage = (CANARY_LANGUAGES as readonly string[]).includes(language)
    ? language
    : "en";

  return (
    <TooltipProvider delayDuration={150}>
      <div role="radiogroup" aria-label="Speech model" className="flex flex-col gap-2.5">
        {downloaded.length > 0 && (
          <div className="text-xs font-medium text-text-muted">Downloaded</div>
        )}
        {downloaded.map(card)}

        {active?.needsLanguage && (
          <div
            id="setting-transcription-language"
            className="flex scroll-mt-24 items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-elevated px-4 py-3"
          >
            <div>
              <div className="text-sm font-medium">Spoken language</div>
              <div className="text-xs text-text-muted">
                {active.name} can&apos;t detect the language, so tell it which one you speak.
              </div>
            </div>
            <Select value={canaryLanguage} onValueChange={changeLanguage}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PARAKEET_LANGUAGES.filter((l) =>
                  (CANARY_LANGUAGES as readonly string[]).includes(l.code),
                ).map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {available.length > 0 && (
          <div className="mt-2 text-xs font-medium text-text-muted">Available to download</div>
        )}
        {available.map(card)}

        {current === null && (
          <p className="text-[11px] text-text-muted">
            {getAiProviderKind() === "local-whisper"
              ? "You're using a custom model file from Advanced options. Pick a model above to switch."
              : "No model from this list is selected yet. Pick one above."}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
