/**
 * The one-decision speech model picker (Settings → AI model and onboarding).
 *
 * Three curated choices instead of an engine dropdown, compute selector,
 * runtime row and a six-tier list: pick one card and it downloads whatever it
 * needs (runtime + model), switches to it when ready and warms it up. The
 * full matrix lives behind "Advanced options" in Settings.
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { toast } from "../ui/Toast";
import { ProgressBar } from "../ui/ProgressBar";
import {
  downloadLocalModel,
  downloadParakeetModel,
  getAiProviderKind,
  getLocalWhisperTier,
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
  setParakeetVariant,
  type WhisperTier,
} from "../../lib/ai";
import {
  SPEECH_CHOICES,
  currentSpeechChoice,
  isSpeechChoiceInstalled,
  type SpeechChoice,
  type SpeechChoiceId,
  type SpeechInstallState,
} from "../../lib/ai/speechChoices";

interface Progress {
  label: string;
  downloaded: number;
  total: number;
}

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
      wm.status === "fulfilled" ? Object.fromEntries(wm.value.map((m) => [m.tier, m.installed])) : {},
    parakeetRuntime: pr.status === "fulfilled" && pr.value,
    parakeetVariants:
      pm.status === "fulfilled"
        ? Object.fromEntries(pm.value.map((m) => [m.variant, m.installed]))
        : {},
  };
}

function formatSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
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

export function SpeechModelPicker({ onChange }: { onChange?: () => void }) {
  const [install, setInstall] = useState<SpeechInstallState>(EMPTY_STATE);
  const [current, setCurrent] = useState<SpeechChoiceId | null>(() =>
    currentSpeechChoice(getAiProviderKind(), getLocalWhisperTier(), getParakeetVariant()),
  );
  const [busy, setBusy] = useState<{ id: SpeechChoiceId; progress: Progress } | null>(null);

  const refresh = async () => setInstall(await readInstallState());

  useEffect(() => {
    void readInstallState().then(setInstall);
    const update = (label: string) => (e: { payload: { downloaded: number; total: number } }) =>
      setBusy((b) =>
        b ? { ...b, progress: { label, downloaded: e.payload.downloaded, total: e.payload.total } } : b,
      );
    const offs = [
      listen<{ downloaded: number; total: number }>(
        "local-whisper:runtime:progress",
        update("Setting up the engine"),
      ),
      listen<{ downloaded: number; total: number }>(
        "local-whisper:download:progress",
        update("Downloading model"),
      ),
      listen<{ downloaded: number; total: number }>(
        "parakeet:runtime:progress",
        update("Setting up the engine"),
      ),
      listen<{ downloaded: number; total: number }>(
        "parakeet:download:progress",
        update("Downloading model"),
      ),
    ];
    return () => offs.forEach((off) => void off.then((fn) => fn()));
  }, []);

  const choose = async (c: SpeechChoice) => {
    if (busy) return;
    if (isSpeechChoiceInstalled(c, install)) {
      applyChoice(c);
      setCurrent(c.id);
      onChange?.();
      return;
    }
    setBusy({ id: c.id, progress: { label: "Starting download", downloaded: 0, total: 0 } });
    try {
      if (c.engine === "local-parakeet") {
        if (!install.parakeetRuntime) await installParakeetRuntime();
        await downloadParakeetModel(c.variant ?? "v3");
      } else {
        if (!install.whisperRuntime) await installWhisperRuntime();
        await downloadLocalModel((c.tier ?? "turbo") as WhisperTier);
      }
      applyChoice(c);
      setCurrent(c.id);
      onChange?.();
      toast.success(`${c.title} is ready`, { description: "Hold your hotkey and start talking." });
    } catch (e) {
      toast.error(`Couldn't set up ${c.title}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {SPEECH_CHOICES.map((c) => {
        const selected = current === c.id;
        const installed = isSpeechChoiceInstalled(c, install);
        const mine = busy?.id === c.id ? busy.progress : null;
        const pct = mine && mine.total > 0 ? Math.round((mine.downloaded / mine.total) * 100) : null;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!!busy && !mine}
            onClick={() => void choose(c)}
            className={cn(
              "flex flex-col gap-2 rounded-md border px-4 py-3 text-left transition-all disabled:opacity-60",
              selected
                ? "border-accent-solid/60 bg-accent-solid/10"
                : "border-border-subtle bg-bg-elevated hover:border-border-strong",
            )}
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-pill border",
                  selected ? "border-transparent bg-accent-solid text-white" : "border-border-strong",
                )}
              >
                {selected && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.title}</span>
                  {c.recommended && (
                    <span className="rounded bg-accent-solid/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-start">
                      Recommended
                    </span>
                  )}
                  <span className="text-[11px] text-text-muted">{c.tagline}</span>
                </div>
                <div className="mt-0.5 text-xs text-text-muted">{c.detail}</div>
              </div>
              <span className="shrink-0 text-[11px] text-text-muted">
                {mine ? (
                  <span className="inline-flex items-center gap-1 text-text-secondary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {pct !== null ? `${pct}%` : "…"}
                  </span>
                ) : selected ? (
                  "In use"
                ) : installed ? (
                  "Downloaded"
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Download className="h-3.5 w-3.5" /> {formatSize(c.approxSizeMB)}
                  </span>
                )}
              </span>
            </div>
            {mine && (
              <div className="pl-7">
                <div className="mb-1 text-[11px] text-text-muted">{mine.label}…</div>
                <ProgressBar value={pct ?? 0} />
              </div>
            )}
          </button>
        );
      })}
      {current === null && (
        <p className="text-[11px] text-text-muted">
          You&apos;re using a custom setup from Advanced options. Pick a card to switch back.
        </p>
      )}
    </div>
  );
}
