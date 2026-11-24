/**
 * The on-device speech benchmark run. Lives outside the Settings view so a
 * long run keeps going (and can't be started twice) when the user switches
 * tabs, and its outcome is still there when they come back.
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { toast } from "../../components/ui/Toast";
import { prewarmEngines } from "../ai";
import {
  loadBenchmarkClips,
  runSpeechBenchmark,
  saveBenchmarkReport,
  type BenchmarkStage,
} from "../ai/speechBenchmark";
import {
  SPEECH_CHOICES,
  isSpeechChoiceInstalled,
  type SpeechChoiceId,
  type SpeechInstallState,
} from "../ai/speechChoices";
import { notifySpeechModelsChanged } from "../ai/speechModels";

const PROGRESS_EVENTS = [
  "local-whisper:runtime:progress",
  "local-whisper:download:progress",
  "parakeet:runtime:progress",
  "parakeet:download:progress",
];

interface SpeechBenchmarkRun {
  running: boolean;
  preparing: boolean;
  stopping: boolean;
  stages: Partial<Record<SpeechChoiceId, BenchmarkStage>>;
  /** Model being worked on now. */
  current: SpeechChoiceId | null;
  /** Download progress of `current`, when known. */
  percent: number | null;
  /**
   * Models that were on disk before the last run, so the review can default
   * to keeping those and offering to remove what the run downloaded. Null
   * once the user has made their choice.
   */
  installedBefore: SpeechChoiceId[] | null;
  /** Increments when a run ends, so a mounted panel can open its review. */
  finishedRuns: number;
  start(install: SpeechInstallState): Promise<void>;
  stop(): void;
  clearInstalledBefore(): void;
}

let controller: AbortController | null = null;

export const useSpeechBenchmark = create<SpeechBenchmarkRun>((set, get) => ({
  running: false,
  preparing: false,
  stopping: false,
  stages: {},
  current: null,
  percent: null,
  installedBefore: null,
  finishedRuns: 0,

  async start(install) {
    if (get().running) return;
    controller = new AbortController();
    const signal = controller.signal;
    set({
      running: true,
      preparing: true,
      stopping: false,
      stages: {},
      current: null,
      percent: null,
      installedBefore: SPEECH_CHOICES.filter((c) => isSpeechChoiceInstalled(c, install)).map(
        (c) => c.id,
      ),
    });
    const offs = PROGRESS_EVENTS.map((name) =>
      listen<{ downloaded: number; total: number }>(name, (e) =>
        set({
          percent:
            e.payload.total > 0 ? Math.round((e.payload.downloaded / e.payload.total) * 100) : null,
        }),
      ),
    );

    try {
      const clips = await loadBenchmarkClips();
      set({ preparing: false });
      const report = await runSpeechBenchmark({
        choices: SPEECH_CHOICES,
        install,
        clips,
        signal,
        onStage: (id, stage) => {
          const idle = stage.kind === "done" || stage.kind === "skipped";
          set((s) => ({
            stages: { ...s.stages, [id]: stage },
            current: idle ? null : id,
            percent: stage.kind === "downloading" || stage.kind === "installing" ? null : s.percent,
          }));
        },
      });
      const results = Object.values(report.results);
      if (results.length > 0) {
        saveBenchmarkReport(report);
        const failed = results.filter((r) => r?.status !== "ok").length;
        toast.success(
          `Tested ${results.length} speech model${results.length === 1 ? "" : "s"} on this computer`,
          {
            description: failed
              ? `${failed} couldn't be tested; the results say why. Choose which models to keep.`
              : "Choose which models to keep in Settings → AI model.",
          },
        );
      }
    } catch (e) {
      toast.error("The speech benchmark couldn't run", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      controller = null;
      offs.forEach((off) => void off.then((fn) => fn()).catch(() => {}));
      // Put the model the user dictates with back into memory.
      prewarmEngines(null);
      set((s) => ({
        running: false,
        preparing: false,
        stopping: false,
        current: null,
        finishedRuns: s.finishedRuns + 1,
      }));
      notifySpeechModelsChanged();
    }
  },

  stop() {
    if (!controller) return;
    set({ stopping: true });
    controller.abort();
  },

  clearInstalledBefore() {
    set({ installedBefore: null });
  },
}));
