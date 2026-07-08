import { VAD_SAMPLE_RATE } from "./vad";

/** Number of samples for a given duration in ms at the VAD rate. */
export function msToSamples(ms: number, sampleRate = VAD_SAMPLE_RATE): number {
  return Math.round((ms / 1000) * sampleRate);
}

/** A block of digital silence. */
export function silence(ms: number, sampleRate = VAD_SAMPLE_RATE): Float32Array {
  return new Float32Array(msToSamples(ms, sampleRate));
}

/** A sine tone burst (approximates voiced speech energy). */
export function tone(
  ms: number,
  { freq = 220, amp = 0.3, sampleRate = VAD_SAMPLE_RATE } = {},
): Float32Array {
  const n = msToSamples(ms, sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** Low-level broadband noise (below speech level). */
export function noise(ms: number, amp = 0.005, sampleRate = VAD_SAMPLE_RATE): Float32Array {
  const n = msToSamples(ms, sampleRate);
  const out = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    // deterministic pseudo-random in [-1, 1)
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((seed / 0x3fffffff) - 1);
  }
  return out;
}

/** Concatenate segments into one buffer. */
export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
