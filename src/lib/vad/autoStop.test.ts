import { describe, expect, it, vi } from "vitest";
import { AutoStopDetector } from "./autoStop";
import { silence, tone } from "./testSignals";

const opts = () => ({
  prefillMs: 90,
  onsetMs: 60,
  hangoverMs: 150,
  minSpeechMs: 60,
  minRecordingMs: 0,
});

describe("AutoStopDetector", () => {
  it("fires once after speech is followed by a hangover of silence", () => {
    const onSilence = vi.fn();
    const d = new AutoStopDetector({ ...opts(), onSilence });
    // Ambient lead-in calibrates the noise floor (mirrors a real clip).
    d.push(silence(300));
    d.push(tone(500, { amp: 0.3 }));
    expect(onSilence).not.toHaveBeenCalled();
    d.push(silence(600));
    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(d.hasFired).toBe(true);
    // Further frames never re-fire.
    d.push(silence(600));
    expect(onSilence).toHaveBeenCalledTimes(1);
  });

  it("never fires on silence-only input", () => {
    const onSilence = vi.fn();
    const d = new AutoStopDetector({ ...opts(), onSilence });
    d.push(silence(2000));
    expect(onSilence).not.toHaveBeenCalled();
  });

  it("never fires before any speech is observed", () => {
    const onSilence = vi.fn();
    const d = new AutoStopDetector({ ...opts(), minSpeechMs: 5000, onSilence });
    d.push(tone(300, { amp: 0.3 }));
    d.push(silence(600));
    expect(onSilence).not.toHaveBeenCalled();
  });

  it("disable() prevents firing", () => {
    const onSilence = vi.fn();
    const d = new AutoStopDetector({ ...opts(), onSilence });
    d.disable();
    d.push(tone(500, { amp: 0.3 }));
    d.push(silence(600));
    expect(onSilence).not.toHaveBeenCalled();
  });
});
