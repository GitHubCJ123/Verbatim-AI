/**
 * Settings → AI model: download every speech model, benchmark them all on
 * this computer, then choose which to keep and uninstall the rest. The run
 * itself lives in `useSpeechBenchmark`, so it survives leaving this view.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Gauge, Loader2, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { ProgressBar } from "../ui/ProgressBar";
import { toast } from "../ui/Toast";
import { formatSize } from "./ModelCard";
import {
  getAiProviderKind,
  getLocalWhisperTier,
  getParakeetVariant,
  prewarmEngines,
} from "../../lib/ai";
import { BENCHMARK_CLIPS } from "../../lib/ai/benchmarkClips";
import {
  SPEECH_CHOICES,
  accuracyScore,
  currentSpeechChoice,
  isSpeechChoiceInstalled,
  speedScore,
  type SpeechChoice,
  type SpeechChoiceId,
  type SpeechInstallState,
} from "../../lib/ai/speechChoices";
import {
  SPEECH_MODELS_CHANGED,
  applySpeechChoice,
  notifySpeechModelsChanged,
  readSpeechInstallState,
  speechChoiceLanguageOk,
  uninstallSpeechChoice,
} from "../../lib/ai/speechModels";
import {
  loadBenchmarkReport,
  type BenchmarkStage,
  type SpeechBenchmarkReport,
} from "../../lib/ai/speechBenchmark";
import { useSpeechBenchmark } from "../../lib/store/useSpeechBenchmark";
import { cn } from "../../lib/utils";

const CLIP_MINUTES = (BENCHMARK_CLIPS.reduce((s, c) => s + c.seconds, 0) / 60).toFixed(1);

function activeChoiceId(): SpeechChoiceId | null {
  return currentSpeechChoice(getAiProviderKind(), getLocalWhisperTier(), getParakeetVariant());
}

function stageText(stage: BenchmarkStage | undefined, percent: number | null): string {
  const pct = percent !== null ? ` ${percent}%` : "…";
  switch (stage?.kind) {
    case undefined:
    case "waiting":
      return "Waiting";
    case "installing":
      return `Setting up engine${pct}`;
    case "downloading":
      return `Downloading${pct}`;
    case "loading":
      return "Loading model…";
    case "testing":
      return `Testing ${stage.done + 1}/${stage.total}`;
    case "skipped":
      return "Skipped";
    case "done":
      return stage.result.status === "ok"
        ? `${stage.result.werPct?.toFixed(1)}% errors · ${stage.result.secondsPer10s?.toFixed(2)} s per 10 s`
        : "Failed";
  }
}

function stagePercent(stage: BenchmarkStage | undefined, percent: number | null): number | null {
  if (stage?.kind === "testing") return Math.round((stage.done / stage.total) * 100);
  if (stage?.kind === "downloading" || stage?.kind === "installing") return percent;
  return null;
}

/** Tested models best-first (lowest error rate, then fastest); the rest after. */
function rankedChoices(report: SpeechBenchmarkReport | null): SpeechChoice[] {
  const key = (c: SpeechChoice): [number, number, number] => {
    const r = report?.results[c.id];
    return r?.status === "ok" ? [0, r.werPct ?? 0, r.secondsPer10s ?? 0] : [r ? 1 : 2, 0, 0];
  };
  return [...SPEECH_CHOICES].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function SpeechBenchmarkPanel({ onChange }: { onChange?: () => void }) {
  const run = useSpeechBenchmark();
  const [view, setView] = useState<"idle" | "confirm" | "review">("idle");
  const [report, setReport] = useState<SpeechBenchmarkReport | null>(loadBenchmarkReport);
  const [install, setInstall] = useState<SpeechInstallState | null>(null);
  const [keep, setKeep] = useState<Set<SpeechChoiceId>>(new Set());
  const [active, setActive] = useState<SpeechChoiceId | null>(activeChoiceId);
  const [applying, setApplying] = useState(false);

  const installed = (c: SpeechChoice) => !!install && isSpeechChoiceInstalled(c, install);
  const missing = install ? SPEECH_CHOICES.filter((c) => !installed(c)) : [];
  const missingMB = missing.reduce((s, c) => s + c.approxSizeMB, 0);

  const openReview = async () => {
    try {
      const state = await readSpeechInstallState();
      const current = activeChoiceId();
      const before = useSpeechBenchmark.getState().installedBefore;
      setInstall(state);
      setActive(current);
      setReport(loadBenchmarkReport());
      // Keep what the user had before the run; what it downloaded is opt-in.
      setKeep(
        new Set(
          SPEECH_CHOICES.filter(
            (c) =>
              isSpeechChoiceInstalled(c, state) &&
              (!before || before.includes(c.id) || c.id === current),
          ).map((c) => c.id),
        ),
      );
      setView("review");
    } catch (e) {
      toast.error("Couldn't check downloaded models", { description: errorText(e) });
    }
  };

  // A run that ends while this view is open goes straight to its review.
  const seenRuns = useRef(run.finishedRuns);
  useEffect(() => {
    if (run.finishedRuns === seenRuns.current) return;
    seenRuns.current = run.finishedRuns;
    void openReview();
  }, [run.finishedRuns]);

  // The model list can switch or delete models too.
  useEffect(() => {
    const resync = () => {
      setActive(activeChoiceId());
      void readSpeechInstallState()
        .then(setInstall)
        .catch(() => {});
    };
    window.addEventListener(SPEECH_MODELS_CHANGED, resync);
    return () => window.removeEventListener(SPEECH_MODELS_CHANGED, resync);
  }, []);

  const openConfirm = async () => {
    try {
      setInstall(await readSpeechInstallState());
      setView("confirm");
    } catch (e) {
      toast.error("Couldn't check downloaded models", { description: errorText(e) });
    }
  };

  const start = () => {
    if (!install) return;
    setView("idle");
    void run.start(install);
  };

  const toggleKeep = (id: SpeechChoiceId) =>
    setKeep((k) => {
      const next = new Set(k);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const use = (c: SpeechChoice) => {
    if (!speechChoiceLanguageOk(c)) {
      toast.error("Choose a Canary spoken language first", {
        description:
          "Canary needs English, German, Spanish or French. Pick one on the Canary card in the model list above.",
      });
      return;
    }
    applySpeechChoice(c);
    setActive(c.id);
    setKeep((k) => new Set(k).add(c.id));
    notifySpeechModelsChanged();
    onChange?.();
    toast.success(`Now using ${c.name}`);
  };

  const toRemove = SPEECH_CHOICES.filter((c) => installed(c) && !keep.has(c.id) && c.id !== active);
  const removeMB = toRemove.reduce((s, c) => s + c.approxSizeMB, 0);

  const closeReview = () => {
    run.clearInstalledBefore();
    setView("idle");
  };

  const uninstall = async () => {
    setApplying(true);
    // The model list may have switched models since this review opened.
    const inUse = activeChoiceId();
    setActive(inUse);
    const targets = toRemove.filter((c) => c.id !== inUse);
    const failures: string[] = [];
    for (const c of targets) {
      try {
        await uninstallSpeechChoice(c);
      } catch (e) {
        failures.push(`${c.name}: ${errorText(e)}`);
      }
    }
    // Deleting stops the warm servers; reload the model in use.
    prewarmEngines(null);
    const removed = targets.length - failures.length;
    if (removed > 0) toast.success(`Uninstalled ${removed} model${removed === 1 ? "" : "s"}`);
    if (failures.length) {
      toast.error(
        `Couldn't uninstall ${failures.length} model${failures.length === 1 ? "" : "s"}`,
        {
          description: failures.join("\n"),
        },
      );
    }
    try {
      setInstall(await readSpeechInstallState());
    } catch {
      // Refreshed again next time the review opens.
    }
    notifySpeechModelsChanged();
    setApplying(false);
    if (!failures.length) closeReview();
  };

  const lastRun = report ? new Date(report.finishedAt).toLocaleString() : null;

  return (
    <section
      id="setting-speech-benchmark"
      aria-label="Test every model on this computer"
      className="mt-4 scroll-mt-24 rounded-lg border border-border-subtle px-4 py-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Gauge className="h-4 w-4 text-accent-start" /> Test every model on this computer
          </div>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            Downloads all {SPEECH_CHOICES.length} speech models, transcribes the same{" "}
            {BENCHMARK_CLIPS.length} English recordings ({CLIP_MINUTES} min) with each, and scores
            accuracy and speed on your hardware. Then choose which to keep and uninstall the rest.
            {lastRun && ` Last run: ${lastRun}.`}
          </p>
        </div>
        {view === "idle" && !run.running && (
          <div className="flex shrink-0 gap-2">
            {report && (
              <Button size="sm" variant="ghost" onClick={() => void openReview()}>
                Review results
              </Button>
            )}
            <Button size="sm" onClick={() => void openConfirm()}>
              {report ? "Run again" : "Download and test all"}
            </Button>
          </div>
        )}
      </div>

      {view === "confirm" && !run.running && (
        <div className="mt-3 rounded-md bg-bg-base px-3 py-3 text-xs leading-relaxed text-text-secondary">
          {missing.length > 0 ? (
            <>
              This downloads {missing.length} model{missing.length === 1 ? "" : "s"} you don&apos;t
              have yet (about {formatSize(missingMB)}
              {(!install?.parakeetRuntime || !install?.whisperRuntime) && ", plus speech engines"}).
              Make sure you have the disk space.
            </>
          ) : (
            <>Every model is already downloaded, so nothing new is downloaded.</>
          )}{" "}
          Testing takes a few minutes per model, longer on older computers. Dictation still works
          meanwhile but may be slower. You can stop at any time.
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={start}>
              Start
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setView("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {run.running && (
        <div className="mt-3 flex flex-col gap-2" role="status" aria-live="polite">
          {run.preparing && (
            <p className="text-xs text-text-secondary">
              <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
              Preparing test recordings…
            </p>
          )}
          <ul className="flex flex-col gap-1.5">
            {SPEECH_CHOICES.map((c) => {
              const stage = run.stages[c.id];
              const isCurrent = c.id === run.current;
              const pct = isCurrent ? run.percent : null;
              const bar = isCurrent ? stagePercent(stage, pct) : null;
              const failed = stage?.kind === "done" && stage.result.status === "failed";
              return (
                <li key={c.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-xs">
                  <span className="truncate">{c.name}</span>
                  <span
                    className={cn(
                      "text-right tabular-nums text-text-muted",
                      isCurrent && "text-text-secondary",
                      failed && "text-danger",
                    )}
                    title={failed ? stage.result.error : undefined}
                  >
                    {isCurrent && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
                    {stageText(stage, pct)}
                  </span>
                  {bar !== null && <ProgressBar className="col-span-2" value={bar} />}
                </li>
              );
            })}
          </ul>
          <div>
            <Button size="sm" variant="ghost" disabled={run.stopping} onClick={run.stop}>
              {run.stopping ? "Stopping after this step…" : "Stop"}
            </Button>
          </div>
        </div>
      )}

      {view === "review" && !run.running && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-text-muted">
            Best first; scores are out of 10, like the model list. Untick a model to uninstall it.
            The model you use can&apos;t be removed.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] text-text-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">Keep</th>
                  <th className="py-1 pr-2 font-medium">Model</th>
                  <th className="py-1 pr-2 font-medium">Accuracy</th>
                  <th className="py-1 pr-2 font-medium">Speed</th>
                  <th className="py-1 pr-2 font-medium">Size</th>
                  <th className="py-1 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rankedChoices(report).map((c) => {
                  const r = report?.results[c.id];
                  const isInstalled = installed(c);
                  const isActive = c.id === active;
                  return (
                    <tr key={c.id} className="border-t border-border-subtle">
                      <td className="py-1.5 pr-2">
                        <input
                          type="checkbox"
                          aria-label={`Keep ${c.name}`}
                          checked={isInstalled && (isActive || keep.has(c.id))}
                          disabled={!isInstalled || isActive || applying}
                          onChange={() => toggleKeep(c.id)}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="font-medium">{c.name}</div>
                        {!isInstalled && (
                          <div className="text-[11px] text-text-muted">Not downloaded</div>
                        )}
                      </td>
                      {r?.status === "ok" &&
                      r.werPct !== undefined &&
                      r.secondsPer10s !== undefined ? (
                        <>
                          <td className="py-1.5 pr-2 tabular-nums">
                            {accuracyScore(r.werPct).toFixed(1)}
                            <span className="text-text-muted">
                              {" "}
                              · {r.werPct.toFixed(1)}% errors
                            </span>
                          </td>
                          <td className="py-1.5 pr-2 tabular-nums">
                            {speedScore(r.secondsPer10s).toFixed(1)}
                            <span className="text-text-muted">
                              {" "}
                              · {r.secondsPer10s.toFixed(2)} s per 10 s
                            </span>
                          </td>
                        </>
                      ) : (
                        <td
                          colSpan={2}
                          className={cn("py-1.5 pr-2", r ? "text-danger" : "text-text-muted")}
                        >
                          {r ? `Couldn't test: ${r.error ?? "unknown error"}` : "Not tested"}
                        </td>
                      )}
                      <td className="py-1.5 pr-2 tabular-nums text-text-muted">
                        {formatSize(c.approxSizeMB)}
                      </td>
                      <td className="py-1.5 text-right">
                        {isActive ? (
                          <span className="inline-flex items-center gap-1 text-accent-start">
                            <Check className="h-3 w-3" strokeWidth={3} /> In use
                          </span>
                        ) : (
                          isInstalled &&
                          r?.status === "ok" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={applying}
                              onClick={() => use(c)}
                            >
                              Use
                            </Button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant={toRemove.length ? "danger" : "secondary"}
              disabled={applying || toRemove.length === 0}
              onClick={() => void uninstall()}
            >
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {toRemove.length
                ? `Uninstall ${toRemove.length} unticked (frees ~${formatSize(removeMB)})`
                : "Nothing to uninstall"}
            </Button>
            <Button size="sm" variant="ghost" disabled={applying} onClick={closeReview}>
              {toRemove.length ? "Keep everything" : "Close"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
