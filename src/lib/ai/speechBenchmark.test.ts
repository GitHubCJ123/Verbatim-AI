import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transcriber } from "./AIProvider";
import {
  loadBenchmarkReport,
  measuredFigures,
  runSpeechBenchmark,
  saveBenchmarkReport,
  type BenchmarkEngine,
  type BenchmarkStage,
  type LoadedClip,
} from "./speechBenchmark";
import { speechChoiceById, type SpeechChoiceId, type SpeechInstallState } from "./speechChoices";

const FIVE_SECONDS = 16_000 * 5;
const CLIPS: LoadedClip[] = [
  { id: "a", seconds: 5, text: "HELLO WORLD", pcm: new Float32Array(FIVE_SECONDS) },
  { id: "b", seconds: 5, text: "THE QUICK BROWN FOX", pcm: new Float32Array(FIVE_SECONDS) },
];
const HYPOTHESES = new Map([
  [CLIPS[0].pcm, "Hello, world!"],
  [CLIPS[1].pcm, "The quick brown box."],
]);

/** Each transcription advances a fake clock by 500 ms. */
function fakeEngine(overrides: Partial<BenchmarkEngine> = {}) {
  let clock = 0;
  const calls = {
    installRuntime: [] as string[],
    downloadModel: [] as string[],
    languages: [] as (string | undefined)[],
  };
  const engine: BenchmarkEngine = {
    installRuntime: async (e) => void calls.installRuntime.push(e),
    downloadModel: async (c) => void calls.downloadModel.push(c.id),
    prepare: async () => {
      clock += 2000;
    },
    transcriber: (): Transcriber => ({
      name: "fake",
      async transcribe(input) {
        calls.languages.push(input.language);
        clock += 500;
        return { text: HYPOTHESES.get(input.pcm!) ?? "", languageDetected: "en", durationMs: 0 };
      },
      health: async () => ({ ok: true, message: "" }),
    }),
    whisperBackend: async () => "cuda",
    now: () => clock,
    ...overrides,
  };
  return { engine, calls };
}

const NOTHING_INSTALLED: SpeechInstallState = {
  whisperRuntime: false,
  whisperTiers: {},
  parakeetRuntime: false,
  parakeetVariants: {},
};

function stagesRecorder() {
  const stages: Array<[SpeechChoiceId, BenchmarkStage["kind"]]> = [];
  return { stages, onStage: (id: SpeechChoiceId, s: BenchmarkStage) => stages.push([id, s.kind]) };
}

afterEach(() => vi.unstubAllGlobals());

describe("runSpeechBenchmark", () => {
  it("downloads only what is missing and measures corpus WER and warm speed", async () => {
    const { engine, calls } = fakeEngine();
    const choices = ["parakeet-v3", "canary-180m-flash", "whisper-base"].map((id) =>
      speechChoiceById(id as SpeechChoiceId),
    );
    const { onStage } = stagesRecorder();
    const report = await runSpeechBenchmark({
      choices,
      install: { ...NOTHING_INSTALLED, parakeetRuntime: true, parakeetVariants: { v3: true } },
      clips: CLIPS,
      onStage,
      engine,
    });

    expect(calls.installRuntime).toEqual(["local-whisper"]);
    expect(calls.downloadModel).toEqual(["canary-180m-flash", "whisper-base"]);
    expect(calls.languages.every((l) => l === "en")).toBe(true);
    // 1 error ("box") over 6 reference words; 2 × 0.5 s for 10 s of audio.
    // The warm-up request and model load are excluded from the speed figure.
    expect(report.results["parakeet-v3"]).toEqual({
      status: "ok",
      werPct: 16.67,
      secondsPer10s: 1,
      loadSeconds: 2.5,
    });
    expect(report.clipCount).toBe(2);
    expect(report.audioSeconds).toBe(10);
    expect(report.whisperBackend).toBe("cuda");
  });

  it("records a failing model and keeps testing the rest", async () => {
    const { engine } = fakeEngine({
      downloadModel: async (c) => {
        if (c.id === "nemotron-en") throw new Error("disk full");
      },
    });
    const report = await runSpeechBenchmark({
      choices: [speechChoiceById("nemotron-en"), speechChoiceById("whisper-tiny")],
      install: NOTHING_INSTALLED,
      clips: CLIPS,
      onStage: () => {},
      engine,
    });
    expect(report.results["nemotron-en"]).toEqual({ status: "failed", error: "disk full" });
    expect(report.results["whisper-tiny"]?.status).toBe("ok");
  });

  it("stops between clips, discarding the partly tested model and skipping the rest", async () => {
    const controller = new AbortController();
    const { engine } = fakeEngine();
    const base = engine.transcriber;
    let requests = 0;
    engine.transcriber = (c) => {
      const t = base(c);
      return {
        ...t,
        transcribe: async (input) => {
          const out = await t.transcribe(input);
          // Warm-up, then the first timed clip: stop before the second.
          if (++requests === 2) controller.abort();
          return out;
        },
      };
    };
    const { stages, onStage } = stagesRecorder();
    const report = await runSpeechBenchmark({
      choices: [speechChoiceById("parakeet-v3"), speechChoiceById("parakeet-v2")],
      install: NOTHING_INSTALLED,
      clips: CLIPS,
      onStage,
      signal: controller.signal,
      engine,
    });
    expect(report.results).toEqual({});
    expect(stages).toContainEqual(["parakeet-v3", "skipped"]);
    expect(stages).toContainEqual(["parakeet-v2", "skipped"]);
    expect(stages.filter(([id]) => id === "parakeet-v2")).toEqual([["parakeet-v2", "skipped"]]);
  });
});

describe("benchmark report storage", () => {
  function storage() {
    const state = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => state.get(k) ?? null,
      setItem: (k: string, v: string) => state.set(k, v),
    });
    return state;
  }

  it("round-trips and exposes only successful figures", () => {
    storage();
    saveBenchmarkReport({
      version: 1,
      finishedAt: "2026-11-23T00:00:00.000Z",
      clipCount: 33,
      audioSeconds: 279,
      whisperBackend: null,
      results: {
        "nemotron-en": { status: "ok", werPct: 3.1, secondsPer10s: 0.8, loadSeconds: 2 },
        "whisper-large-v3": { status: "failed", error: "out of memory" },
      },
    });
    const report = loadBenchmarkReport();
    expect(measuredFigures(report, "nemotron-en")).toEqual({ werPct: 3.1, secondsPer10s: 0.8 });
    expect(measuredFigures(report, "whisper-large-v3")).toBeNull();
    expect(measuredFigures(report, "parakeet-v3")).toBeNull();
  });

  it("ignores unreadable stored reports", () => {
    const state = storage();
    state.set("sw.ai.speechBenchmark", "{not json");
    expect(loadBenchmarkReport()).toBeNull();
    state.set("sw.ai.speechBenchmark", JSON.stringify({ version: 2, results: {} }));
    expect(loadBenchmarkReport()).toBeNull();
  });
});
