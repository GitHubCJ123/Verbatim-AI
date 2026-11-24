/**
 * On-device speech benchmark: downloads every built-in model, transcribes the
 * bundled LibriSpeech clips with each one through the same path dictation
 * uses, and records word error rate and speed on this computer's hardware.
 * The report is kept locally and replaces the reference figures on the model
 * cards.
 */
import type { Transcriber } from "./AIProvider";
import { decodeToMonoF32_16k } from "./audioDecode";
import { BENCHMARK_AUDIO_DIR, BENCHMARK_CLIPS, type BenchmarkClip } from "./benchmarkClips";
import {
  LocalWhisperProvider,
  ensureWhisperEngineReady,
  getActiveWhisperRuntimeVariant,
  resolveWhisperCommand,
} from "./localWhisper";
import { ParakeetProvider, ensureParakeetReady } from "./parakeet";
import {
  isSpeechChoiceInstalled,
  type SpeechChoice,
  type SpeechChoiceId,
  type SpeechInstallState,
} from "./speechChoices";
import { downloadSpeechModel, installSpeechRuntime } from "./speechModels";
import { wordErrors } from "./wordErrorRate";

const LS_REPORT = "sw.ai.speechBenchmark";
/** The clips are English; every model is told so. */
export const BENCHMARK_LANGUAGE = "en";
const SAMPLE_RATE = 16_000;

export interface LoadedClip extends BenchmarkClip {
  /** 16 kHz mono samples. */
  pcm: Float32Array;
}

export interface ModelBenchmarkResult {
  status: "ok" | "failed";
  /** Word error rate over all clips, percent. */
  werPct?: number;
  /** Seconds of transcription per 10 s of speech, model already loaded. */
  secondsPer10s?: number;
  /** Seconds to load the model and transcribe the first clip cold. */
  loadSeconds?: number;
  error?: string;
}

export interface SpeechBenchmarkReport {
  version: 1;
  finishedAt: string;
  clipCount: number;
  audioSeconds: number;
  /** Whisper's compute backend for the run ("cuda", "metal", …), if known. */
  whisperBackend: string | null;
  results: Partial<Record<SpeechChoiceId, ModelBenchmarkResult>>;
}

export type BenchmarkStage =
  | { kind: "waiting" }
  | { kind: "installing" }
  | { kind: "downloading" }
  | { kind: "loading" }
  | { kind: "testing"; done: number; total: number }
  | { kind: "done"; result: ModelBenchmarkResult }
  | { kind: "skipped" };

/** Side effects the runner needs; swapped out in tests. */
export interface BenchmarkEngine {
  installRuntime(engine: SpeechChoice["engine"]): Promise<void>;
  downloadModel(c: SpeechChoice): Promise<void>;
  /** Load the model into its warm server where the app would use one. */
  prepare(c: SpeechChoice): Promise<void>;
  transcriber(c: SpeechChoice): Transcriber;
  whisperBackend(): Promise<string | null>;
  now(): number;
}

export const defaultBenchmarkEngine: BenchmarkEngine = {
  installRuntime: installSpeechRuntime,
  downloadModel: downloadSpeechModel,
  async prepare(c) {
    if (c.engine === "local-parakeet") {
      await ensureParakeetReady(c.variant ?? "v3", BENCHMARK_LANGUAGE);
    } else if ((await resolveWhisperCommand()) === "transcribe_local_server_pcm") {
      await ensureWhisperEngineReady(c.tier ?? "turbo");
    }
  },
  transcriber: (c) =>
    c.engine === "local-parakeet"
      ? new ParakeetProvider({ variant: c.variant ?? "v3", language: BENCHMARK_LANGUAGE })
      : new LocalWhisperProvider({ tier: c.tier ?? "turbo" }),
  whisperBackend: () => getActiveWhisperRuntimeVariant().catch(() => null),
  now: () => performance.now(),
};

/** Fetch and decode the bundled recordings (sequentially: one AudioContext at a time). */
export async function loadBenchmarkClips(): Promise<LoadedClip[]> {
  const out: LoadedClip[] = [];
  for (const clip of BENCHMARK_CLIPS) {
    const res = await fetch(`${import.meta.env.BASE_URL}${BENCHMARK_AUDIO_DIR}/${clip.id}.mp3`);
    if (!res.ok) throw new Error(`Couldn't load test recording ${clip.id} (HTTP ${res.status})`);
    out.push({ ...clip, pcm: await decodeToMonoF32_16k(await res.blob()) });
  }
  return out;
}

const EMPTY_AUDIO = new Blob([]);

class Stopped extends Error {}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function benchmarkOne(
  c: SpeechChoice,
  clips: LoadedClip[],
  engine: BenchmarkEngine,
  onStage: (stage: BenchmarkStage) => void,
  signal?: AbortSignal,
): Promise<ModelBenchmarkResult> {
  const transcribe = (t: Transcriber, clip: LoadedClip) =>
    t.transcribe({ audio: EMPTY_AUDIO, pcm: clip.pcm, language: BENCHMARK_LANGUAGE });

  onStage({ kind: "loading" });
  const loadStarted = engine.now();
  await engine.prepare(c);
  const t = engine.transcriber(c);
  // Untimed warm-up: the first request pays one-off costs (model load for
  // engines without a warm server, graph init) that dictation pays only once.
  await transcribe(t, clips[0]);
  const loadSeconds = (engine.now() - loadStarted) / 1000;

  let errors = 0;
  let words = 0;
  let elapsedMs = 0;
  let audioSeconds = 0;
  for (const [i, clip] of clips.entries()) {
    if (signal?.aborted) throw new Stopped();
    onStage({ kind: "testing", done: i, total: clips.length });
    const started = engine.now();
    const out = await transcribe(t, clip);
    elapsedMs += engine.now() - started;
    const e = wordErrors(clip.text, out.text);
    errors += e.errors;
    words += e.words;
    audioSeconds += clip.pcm.length / SAMPLE_RATE;
  }
  return {
    status: "ok",
    werPct: round((errors / Math.max(1, words)) * 100, 2),
    secondsPer10s: round((elapsedMs / 1000 / Math.max(1e-9, audioSeconds)) * 10, 2),
    loadSeconds: round(loadSeconds, 1),
  };
}

/**
 * Download (if needed) and benchmark each model in turn. A model that fails is
 * recorded and the run moves on; aborting skips the rest and discards the
 * partly tested model.
 */
export async function runSpeechBenchmark(opts: {
  choices: SpeechChoice[];
  install: SpeechInstallState;
  clips: LoadedClip[];
  onStage: (id: SpeechChoiceId, stage: BenchmarkStage) => void;
  signal?: AbortSignal;
  engine?: BenchmarkEngine;
}): Promise<SpeechBenchmarkReport> {
  const { choices, clips, onStage, signal } = opts;
  const engine = opts.engine ?? defaultBenchmarkEngine;
  if (clips.length === 0) throw new Error("No test recordings to benchmark with.");
  const install: SpeechInstallState = {
    ...opts.install,
    whisperTiers: { ...opts.install.whisperTiers },
    parakeetVariants: { ...opts.install.parakeetVariants },
  };
  const whisperBackend = choices.some((c) => c.engine === "local-whisper")
    ? await engine.whisperBackend()
    : null;
  const results: SpeechBenchmarkReport["results"] = {};

  for (const c of choices) {
    if (signal?.aborted) {
      onStage(c.id, { kind: "skipped" });
      continue;
    }
    const stage = (s: BenchmarkStage) => onStage(c.id, s);
    let result: ModelBenchmarkResult;
    try {
      const parakeet = c.engine === "local-parakeet";
      if (!(parakeet ? install.parakeetRuntime : install.whisperRuntime)) {
        stage({ kind: "installing" });
        await engine.installRuntime(c.engine);
        if (parakeet) install.parakeetRuntime = true;
        else install.whisperRuntime = true;
      }
      if (!isSpeechChoiceInstalled(c, install)) {
        stage({ kind: "downloading" });
        await engine.downloadModel(c);
        if (parakeet) install.parakeetVariants[c.variant ?? "v3"] = true;
        else install.whisperTiers[c.tier ?? "turbo"] = true;
      }
      if (signal?.aborted) throw new Stopped();
      result = await benchmarkOne(c, clips, engine, stage, signal);
    } catch (e) {
      if (e instanceof Stopped) {
        stage({ kind: "skipped" });
        continue;
      }
      result = { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    results[c.id] = result;
    stage({ kind: "done", result });
  }

  return {
    version: 1,
    finishedAt: new Date().toISOString(),
    clipCount: clips.length,
    audioSeconds: round(
      clips.reduce((s, c) => s + c.pcm.length / SAMPLE_RATE, 0),
      1,
    ),
    whisperBackend,
    results,
  };
}

export function saveBenchmarkReport(report: SpeechBenchmarkReport): void {
  localStorage.setItem(LS_REPORT, JSON.stringify(report));
}

export function loadBenchmarkReport(): SpeechBenchmarkReport | null {
  try {
    const raw = localStorage.getItem(LS_REPORT);
    const parsed = raw ? (JSON.parse(raw) as SpeechBenchmarkReport) : null;
    if (parsed?.version !== 1 || typeof parsed.results !== "object" || !parsed.results) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** This computer's measured figures for `id`, if a benchmark produced them. */
export function measuredFigures(
  report: SpeechBenchmarkReport | null,
  id: SpeechChoiceId,
): { werPct: number; secondsPer10s: number } | null {
  const r = report?.results[id];
  if (r?.status !== "ok" || r.werPct === undefined || r.secondsPer10s === undefined) return null;
  return { werPct: r.werPct, secondsPer10s: r.secondsPer10s };
}
