import { describe, expect, it } from "vitest";
import {
  EnergyVad,
  SmoothedVad,
  frameRms,
  peakAbs,
  toFrames,
  VAD_FRAME_SAMPLES,
} from "./vad";
import { silence, tone } from "./testSignals";

describe("frame helpers", () => {
  it("computes RMS and peak", () => {
    expect(frameRms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(frameRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 5);
    expect(peakAbs(new Float32Array([0.1, -0.9, 0.4]))).toBeCloseTo(0.9, 5);
  });

  it("splits into fixed frames, zero-padding the tail", () => {
    const frames = toFrames(new Float32Array(VAD_FRAME_SAMPLES + 10));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(VAD_FRAME_SAMPLES);
    expect(frames[1]).toHaveLength(VAD_FRAME_SAMPLES);
  });
});

describe("EnergyVad", () => {
  it("reports ~0 for silence and ~1 for a loud tone", () => {
    const vad = new EnergyVad();
    // Warm the noise floor on silence frames.
    const silentFrames = toFrames(silence(300));
    let lastSilent = 1;
    for (const f of silentFrames) lastSilent = vad.speechProbability(f);
    expect(lastSilent).toBe(0);

    const toneFrames = toFrames(tone(300, { amp: 0.3 }));
    const probs = toneFrames.map((f) => vad.speechProbability(f));
    expect(Math.max(...probs)).toBe(1);
  });
});

describe("SmoothedVad", () => {
  it("requires onset frames before declaring speech and holds through hangover", () => {
    const vad = new SmoothedVad({
      prefillMs: 90,
      onsetMs: 60, // 2 frames
      hangoverMs: 150, // 5 frames
    });
    const feed = (buf: Float32Array) => toFrames(buf).map((f) => vad.process(f).isSpeech);

    // Prefill window: no speech emitted even if energy is present.
    const early = feed(silence(120));
    expect(early.every((s) => s === false)).toBe(true);

    // Sustained tone flips to speech after the onset window.
    const during = feed(tone(300, { amp: 0.3 }));
    expect(during.some((s) => s === true)).toBe(true);
    expect(vad.isSpeech).toBe(true);

    // A single quiet frame must not immediately drop speech (hangover).
    const oneQuiet = vad.process(silence(30));
    expect(oneQuiet.isSpeech).toBe(true);

    // Prolonged silence eventually drops below hangover.
    const tail = feed(silence(300));
    expect(tail[tail.length - 1]).toBe(false);
  });

  it("reset clears adaptive state", () => {
    const vad = new SmoothedVad();
    toFrames(tone(300)).forEach((f) => vad.process(f));
    vad.reset();
    expect(vad.isSpeech).toBe(false);
  });
});
