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
import { recommendedSpeechChoice } from "./modelPresentation";
import { loadHotkeyConfig, usesHoldToTalk } from "../../lib/hotkey";
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
  const [wr, wm, pr, pm] = await Promise.all([
    isWhisperRuntimeInstalled(),
    listLocalModels(),
    isParakeetRuntimeInstalled(),
    listParakeetModels(),
  ]);
  return {
    whisperRuntime: wr,
    whisperTiers: Object.fromEntries(wm.map((m) => [m.tier, m.installed])),
    parakeetRuntime: pr,
    parakeetVariants: Object.fromEntries(pm.map((m) => [m.variant, m.installed])),
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
  const canaryLanguage = (CANARY_LANGUAGES as readonly string[]).includes(language) ? language : "";
  const [recommendationLanguage, setRecommendationLanguage] = useState(getParakeetLanguage);
  const [advanced, setAdvanced] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<{
    id: SpeechChoiceId;
    label: string;
    percent: number | null;
  } | null>(null);

  const refresh = async () => {
    try {
      setInstall(await readInstallState());
      setReadError(null);
      setChecked(true);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    const read = async () => {
      try {
        setInstall(await readInstallState());
        setReadError(null);
        setChecked(true);
      } catch (e) {
        setReadError(e instanceof Error ? e.message : String(e));
      }
    };
    void read();
    window.addEventListener("focus", read);
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
    for (const off of offs) {
      void off.catch((e) => setReadError(e instanceof Error ? e.message : String(e)));
    }
    return () => {
      window.removeEventListener("focus", read);
      offs.forEach((off) => void off.then((fn) => fn()).catch(() => {}));
    };
  }, []);

  const canUseChoice = (c: SpeechChoice) => {
    if (!c.needsLanguage || canaryLanguage) return true;
    setAdvanced(true);
    toast.error("Choose a Canary spoken language", {
      description:
        "Canary supports English, German, Spanish and French. Your saved language has not been changed.",
    });
    return false;
  };

  const activate = (c: SpeechChoice) => {
    if (!canUseChoice(c)) return;
    applyChoice(c);
    setCurrent(c.id);
    onChange?.();
  };

  const download = async (c: SpeechChoice) => {
    if (busy || !canUseChoice(c)) return;
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
      const cfg = loadHotkeyConfig();
      toast.success(`${c.name} is ready`, {
        description: usesHoldToTalk(cfg)
          ? "Hold your hotkey to record; release to finish."
          : "Press your hotkey to record; press again to finish.",
      });
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
      recommended={c.id === recommended.id}
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

  const recommended = recommendedSpeechChoice(recommendationLanguage);
  const foreground = SPEECH_CHOICES.filter((c) => c.id === recommended.id || c.id === current);
  const catalog = SPEECH_CHOICES.filter((c) => !foreground.includes(c));
  const active = current ? speechChoiceById(current) : null;

  return (
    <TooltipProvider delayDuration={150}>
      <div role="radiogroup" aria-label="Speech model" className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle px-4 py-3">
          <div>
            <div className="text-sm font-medium">Choose a recommendation</div>
            <p className="text-xs text-text-muted">
              Only changes this suggestion, not your saved model or language.
            </p>
          </div>
          <Select value={recommendationLanguage} onValueChange={setRecommendationLanguage}>
            <SelectTrigger className="w-48" aria-label="Language for model recommendation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Mixed / other languages</SelectItem>
              {PARAKEET_LANGUAGES.filter((l) => l.code !== "auto").map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.label}
                </SelectItem>
              ))}
              {!PARAKEET_LANGUAGES.some((l) => l.code === recommendationLanguage) && (
                <SelectItem value={recommendationLanguage}>
                  Other ({recommendationLanguage})
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <div
          role="status"
          className="rounded-md border border-border-subtle px-4 py-3 text-xs text-text-secondary"
        >
          {readError
            ? `Couldn't check model readiness: ${readError}`
            : !checked
              ? "Checking downloaded models…"
              : active
                ? `${active.name}: ${isSpeechChoiceInstalled(active, install) ? "downloaded and selected" : "setup needed"}.`
                : "Your current setup is not a built-in model. It has not been changed; check it in Settings → Advanced."}
          <button type="button" onClick={() => void refresh()} className="ml-2 underline">
            Check again
          </button>
        </div>
        {foreground.map(card)}

        {(active?.needsLanguage || advanced) && (
          <div
            id="setting-transcription-language"
            className="flex scroll-mt-24 items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-elevated px-4 py-3"
          >
            <div>
              <div className="text-sm font-medium">Canary spoken language</div>
              <div className="text-xs text-text-muted">
                Canary can&apos;t detect the language. Choose one before using it. This updates the
                saved spoken language, not just the recommendation.
                {!canaryLanguage &&
                  " Your saved language is unsupported. Choose a supported language or use Whisper; nothing has been changed."}
              </div>
            </div>
            <Select value={canaryLanguage} onValueChange={changeLanguage}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Choose language" />
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

        <details open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
          <summary className="cursor-pointer py-3 text-xs font-medium text-text-secondary">
            Advanced · all speech models ({catalog.length} more)
          </summary>
          <div className="flex flex-col gap-2.5">{catalog.map(card)}</div>
        </details>

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
