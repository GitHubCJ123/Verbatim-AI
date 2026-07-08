import { describe, expect, it, vi } from "vitest";
import { PartialSegmenter } from "./segmenter";
import { concat, silence, tone } from "../vad/testSignals";

/** Responsive VAD so boundaries land quickly in short test clips. */
const vadOpts = {
  prefillMs: 90,
  onsetMs: 60,
  hangoverMs: 150,
} as const;

describe("PartialSegmenter", () => {
  it("emits on a fixed cadence with cumulative audio-so-far", () => {
    const payloads: number[] = [];
    const seg = new PartialSegmenter({
      emitOnBoundary: false,
      intervalMs: 500,
      minAudioMs: 0,
      onPartial: (pcm) => payloads.push(pcm.length),
      ...vadOpts,
    });
    // 1200 ms of tone → cadence fires at ~510 ms and ~1020 ms.
    seg.push(tone(1200, { amp: 0.3 }));
    expect(payloads).toHaveLength(2);
    // Cumulative: each partial contains more samples than the last.
    expect(payloads[1]).toBeGreaterThan(payloads[0]);
  });

  it("does not emit before the minimum audio threshold", () => {
    const onPartial = vi.fn();
    const seg = new PartialSegmenter({
      emitOnBoundary: false,
      intervalMs: 100,
      minAudioMs: 800,
      onPartial,
      ...vadOpts,
    });
    seg.push(tone(400, { amp: 0.3 }));
    expect(onPartial).not.toHaveBeenCalled();
  });

  it("emits on a VAD speech→silence boundary", () => {
    const onPartial = vi.fn();
    const seg = new PartialSegmenter({
      emitOnBoundary: true,
      // Huge cadence so only the boundary can trigger.
      intervalMs: 1_000_000,
      minAudioMs: 0,
      onPartial,
      ...vadOpts,
    });
    seg.push(concat(silence(300), tone(500, { amp: 0.3 }), silence(600)));
    expect(onPartial).toHaveBeenCalledTimes(1);
  });

  it("stops emitting once the max-audio cap is reached", () => {
    const payloads: number[] = [];
    const seg = new PartialSegmenter({
      emitOnBoundary: false,
      intervalMs: 100,
      minAudioMs: 0,
      maxAudioMs: 300,
      onPartial: (pcm) => payloads.push(pcm.length),
      ...vadOpts,
    });
    seg.push(tone(2000, { amp: 0.3 }));
    const countAtCap = payloads.length;
    // Cap caps both count and payload size (<= 300 ms @ 16 kHz = 4800).
    expect(countAtCap).toBeGreaterThan(0);
    expect(Math.max(...payloads)).toBeLessThanOrEqual(4800);
    // More audio past the cap yields no further partials.
    seg.push(tone(1000, { amp: 0.3 }));
    expect(payloads).toHaveLength(countAtCap);
  });

  it("stops emitting after dispose", () => {
    const onPartial = vi.fn();
    const seg = new PartialSegmenter({
      emitOnBoundary: false,
      intervalMs: 100,
      minAudioMs: 0,
      onPartial,
      ...vadOpts,
    });
    seg.push(tone(300, { amp: 0.3 }));
    const before = onPartial.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    seg.dispose();
    seg.push(tone(2000, { amp: 0.3 }));
    expect(onPartial.mock.calls.length).toBe(before);
  });
});
