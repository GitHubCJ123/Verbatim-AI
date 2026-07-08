import { describe, expect, it } from "vitest";
import { trimSilence } from "./trim";
import { peakAbs } from "./vad";
import { silence, tone, noise, concat } from "./testSignals";

describe("trimSilence", () => {
  it("flags a pure-silence clip as silent", () => {
    const res = trimSilence(silence(1500));
    expect(res.isSilent).toBe(true);
    expect(res.trimmed).toBe(false);
  });

  it("trims leading and trailing silence without cutting speech", () => {
    const speech = tone(500, { amp: 0.3 });
    const clip = concat(silence(700), speech, silence(1200));
    const res = trimSilence(clip);

    expect(res.isSilent).toBe(false);
    expect(res.trimmed).toBe(true);
    expect(res.leadingTrimmedMs).toBeGreaterThan(0);
    expect(res.trailingTrimmedMs).toBeGreaterThan(0);
    // Must not trim into the speech: leading cut stays before the 700ms
    // onset and trailing cut stays after speech ends (~1200ms).
    expect(res.leadingTrimmedMs).toBeLessThan(700);
    expect(res.trailingTrimmedMs).toBeLessThan(1200);
    // Kept clip is shorter but still holds the full-amplitude speech.
    expect(res.pcm.length).toBeLessThan(clip.length);
    expect(peakAbs(res.pcm)).toBeCloseTo(0.3, 1);
  });

  it("leaves an all-speech clip essentially untouched", () => {
    const res = trimSilence(tone(1200, { amp: 0.3 }));
    expect(res.isSilent).toBe(false);
    expect(res.leadingTrimmedMs).toBe(0);
  });

  it("fails open on a short clip", () => {
    const res = trimSilence(tone(20, { amp: 0.3 }));
    expect(res.trimmed).toBe(false);
    expect(res.isSilent).toBe(false);
  });

  it("does not drop a low-level-noise clip with no detected speech", () => {
    // Energy above the silence peak but no speech-like onset: fail open,
    // keep the audio (never drop possible quiet speech in a noisy room).
    const clip = concat(noise(1500, 0.03));
    const res = trimSilence(clip);
    expect(res.isSilent).toBe(false);
    expect(res.pcm.length).toBe(clip.length);
  });
});
