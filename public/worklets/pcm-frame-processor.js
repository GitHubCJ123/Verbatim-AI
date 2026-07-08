/**
 * AudioWorklet: real-time PCM frame emitter
 * (docs/proposals/handy-adoption.md §Phase 3, route 3A).
 *
 * Runs on the audio render thread. Downsamples the incoming mic stream
 * from the AudioContext sample rate to 16 kHz mono and posts fixed-size
 * Float32 frames (~30 ms / 480 samples) to the main thread *during*
 * recording, unblocking VAD auto-stop and future streaming.
 *
 * Plain JS (no bundling) so it can be loaded via `audioWorklet.addModule`.
 */
const TARGET_RATE = 16000;
const FRAME_SIZE = 480; // 30 ms @ 16 kHz

class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.tail = new Float32Array(0); // carry-over input for continuity
    this.frac = 0; // fractional read position within (tail+block)
    this.out = new Float32Array(FRAME_SIZE);
    this.outIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch || ch.length === 0) return true;

    // Prepend leftover samples so linear interpolation is seamless
    // across render blocks.
    const buf = new Float32Array(this.tail.length + ch.length);
    buf.set(this.tail);
    buf.set(ch, this.tail.length);

    let pos = this.frac;
    while (pos + 1 < buf.length) {
      const i = pos | 0;
      const f = pos - i;
      this.out[this.outIdx++] = buf[i] * (1 - f) + buf[i + 1] * f;
      if (this.outIdx === FRAME_SIZE) {
        // Copy out; the buffer is reused for the next frame.
        this.port.postMessage(this.out.slice(0));
        this.outIdx = 0;
      }
      pos += this.step;
    }

    const keepFrom = Math.min(pos | 0, buf.length);
    this.tail = buf.slice(keepFrom);
    this.frac = pos - keepFrom;
    return true;
  }
}

registerProcessor("pcm-frame-processor", PcmFrameProcessor);
