import { describe, expect, it } from "vitest";
import {
  SileroVad,
  PrecomputedVad,
  precomputeVad,
  SILERO_WINDOW_SAMPLES,
  SILERO_STATE_SIZE,
  type SileroSession,
  type SileroInferResult,
} from "./silero";
import { SmoothedVad, toFrames, VAD_FRAME_SAMPLES } from "./vad";

/**
 * A deterministic mock Silero session. Speech probability is a step
 * function of the window's mean absolute amplitude, and the LSTM state
 * is threaded by incrementing its first element each call — enough to
 * assert state resets and continuity without a real network.
 */
function makeMockSession(): SileroSession & {
  calls: Array<{ window: Float32Array; state: Float32Array }>;
} {
  const calls: Array<{ window: Float32Array; state: Float32Array }> = [];
  return {
    calls,
    async infer(window: Float32Array, state: Float32Array): Promise<SileroInferResult> {
      calls.push({ window, state: Float32Array.from(state) });
      let sum = 0;
      for (let i = 0; i < window.length; i++) sum += Math.abs(window[i]);
      const probability = sum / window.length > 0.1 ? 0.92 : 0.03;
      const next = Float32Array.from(state);
      next[0] += 1;
      return { probability, state: next };
    },
  };
}

const loudFrame = (n = VAD_FRAME_SAMPLES) => new Float32Array(n).fill(0.5);
const quietFrame = (n = VAD_FRAME_SAMPLES) => new Float32Array(n).fill(0);

describe("SileroVad windowing", () => {
  it("only runs inference once a full 512-sample window is buffered", async () => {
    const session = makeMockSession();
    const vad = new SileroVad(session);

    // One 480-sample frame isn't enough for a 512-sample window.
    const p0 = await vad.speechProbabilityAsync(loudFrame());
    expect(session.calls).toHaveLength(0);
    expect(p0).toBe(0);

    // Two frames (960 samples) yield exactly one full window.
    const p1 = await vad.speechProbabilityAsync(loudFrame());
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0].window).toHaveLength(SILERO_WINDOW_SAMPLES);
    expect(p1).toBeCloseTo(0.92, 5);
  });

  it("reports low probability for silence and high for loud audio", async () => {
    const session = makeMockSession();
    const vad = new SileroVad(session);
    await vad.speechProbabilityAsync(quietFrame());
    const quiet = await vad.speechProbabilityAsync(quietFrame());
    expect(quiet).toBeLessThan(0.1);

    vad.reset();
    await vad.speechProbabilityAsync(loudFrame());
    const loud = await vad.speechProbabilityAsync(loudFrame());
    expect(loud).toBeGreaterThan(0.5);
  });
});

describe("SileroVad LSTM state", () => {
  it("threads the returned state into the next inference call", async () => {
    const session = makeMockSession();
    const vad = new SileroVad(session);
    // Feed enough for two windows (3 frames = 1440 samples → 2 windows).
    await vad.speechProbabilityAsync(loudFrame());
    await vad.speechProbabilityAsync(loudFrame());
    await vad.speechProbabilityAsync(loudFrame());
    expect(session.calls.length).toBeGreaterThanOrEqual(2);
    // First call sees zero state; second sees the incremented state.
    expect(session.calls[0].state[0]).toBe(0);
    expect(session.calls[1].state[0]).toBe(1);
  });

  it("resets LSTM state and buffered samples between recordings", async () => {
    const session = makeMockSession();
    const vad = new SileroVad(session);
    await vad.speechProbabilityAsync(loudFrame());
    await vad.speechProbabilityAsync(loudFrame());
    const before = session.calls.length;
    expect(before).toBeGreaterThan(0);

    vad.reset();
    // After reset, the next window must again see a fully-zeroed state.
    await vad.speechProbabilityAsync(loudFrame());
    await vad.speechProbabilityAsync(loudFrame());
    const firstAfterReset = session.calls[before];
    expect(firstAfterReset.state.every((v) => v === 0)).toBe(true);
    expect(firstAfterReset.state).toHaveLength(SILERO_STATE_SIZE);
  });

  it("discards a stale inference that resolves after reset (no cross-clip bleed)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const statesSeen: Float32Array[] = [];
    const session: SileroSession = {
      async infer(_w, state) {
        calls++;
        statesSeen.push(Float32Array.from(state));
        if (calls === 1) await gate; // hold the first inference open
        const next = Float32Array.from(state);
        next[0] += 5; // a distinctive, non-zero state mutation
        return { probability: 0.9, state: next };
      },
    };
    const vad = new SileroVad(session);
    // A 1024-sample frame yields a full 512-window; its inference starts
    // and suspends on the gate (do NOT await — it's held open).
    const first = vad.speechProbabilityAsync(new Float32Array(1024).fill(0.5));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1); // inference started, held on the gate

    // Reset between recordings while that inference is still pending,
    // then let the stale inference resolve.
    vad.reset();
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));

    // A fresh single window after reset must see a fully-zeroed state —
    // the stale (+5) result from the pre-reset inference must have been
    // discarded rather than threaded into the new recording.
    await vad.speechProbabilityAsync(new Float32Array(512).fill(0.5));
    const postReset = statesSeen[statesSeen.length - 1];
    expect(postReset.every((v) => v === 0)).toBe(true);
  });
});

describe("SileroVad realtime (sync) path", () => {
  it("returns the last completed probability, updating after inference settles", async () => {
    const session = makeMockSession();
    const vad = new SileroVad(session);
    // Sync call before any window is complete → default 0.
    expect(vad.speechProbability(loudFrame())).toBe(0);
    // Fire-and-forget inference; flush microtasks.
    vad.speechProbability(loudFrame());
    await new Promise((r) => setTimeout(r, 0));
    expect(vad.speechProbability(loudFrame())).toBeGreaterThan(0.5);
  });
});

describe("PrecomputedVad", () => {
  it("replays probabilities in order and returns 0 past the end", () => {
    const vad = new PrecomputedVad([0.1, 0.9, 0.4]);
    const f = quietFrame();
    expect(vad.speechProbability(f)).toBeCloseTo(0.1);
    expect(vad.speechProbability(f)).toBeCloseTo(0.9);
    expect(vad.speechProbability(f)).toBeCloseTo(0.4);
    expect(vad.speechProbability(f)).toBe(0);
  });

  it("restarts the replay on reset", () => {
    const vad = new PrecomputedVad([0.7, 0.2]);
    const f = quietFrame();
    expect(vad.speechProbability(f)).toBeCloseTo(0.7);
    vad.reset();
    expect(vad.speechProbability(f)).toBeCloseTo(0.7);
  });
});

describe("precomputeVad", () => {
  it("produces exactly one probability per frame", async () => {
    const session = makeMockSession();
    const vad = new SileroVad(session);
    const pcm = new Float32Array(VAD_FRAME_SAMPLES * 5).fill(0.5);
    const replay = await precomputeVad(pcm, vad);
    const frames = toFrames(pcm);
    // The replay yields one probability per frame; later frames (after a
    // window completes) should read as speech.
    const probs = frames.map(() => replay.speechProbability(quietFrame()));
    expect(probs).toHaveLength(frames.length);
    expect(probs.some((p) => p > 0.5)).toBe(true);
  });

  it("feeds real Silero scores into SmoothedVad and detects speech", async () => {
    const session = makeMockSession();
    const vad = new SileroVad(session);
    const pcm = new Float32Array(VAD_FRAME_SAMPLES * 40).fill(0.5);
    const model = await precomputeVad(pcm, vad);

    const smoothed = new SmoothedVad({ model, prefillMs: 0 });
    let sawSpeech = false;
    for (const frame of toFrames(pcm)) {
      if (smoothed.process(frame).isSpeech) sawSpeech = true;
    }
    expect(sawSpeech).toBe(true);
  });
});
