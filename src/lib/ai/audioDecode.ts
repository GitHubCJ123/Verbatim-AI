/**
 * Shared audio decode helper used by on-device transcription providers.
 * Decodes an arbitrary audio Blob to 16 kHz mono Float32 PCM, which is
 * the canonical input format for both whisper.cpp and sherpa-onnx.
 */
export async function decodeToMonoF32_16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();
  const tmpCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    await tmpCtx.close();
  }
  const targetSampleRate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
  const off = new OfflineAudioContext(1, length, targetSampleRate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}

/** The input's 16 kHz mono PCM, decoding the Blob only when none was supplied. */
export async function pcm16kFor(input: { audio: Blob; pcm?: Float32Array }): Promise<Float32Array> {
  return input.pcm ?? decodeToMonoF32_16k(input.audio);
}

/** Copy PCM into a standalone byte buffer for a raw-body Tauri invoke. */
export function pcmToBytes(samples: Float32Array): Uint8Array {
  const view = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

/**
 * Whisper initial prompt built from the user's vocabulary: a short glossary
 * biases spelling of names and jargon. URI-encoded because Tauri IPC header
 * values must be ASCII; Rust decodes it.
 */
export function vocabularyPromptHeader(hints?: string[]): string {
  const terms = (hints ?? []).map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return "";
  return encodeURIComponent(terms.slice(0, 40).join(", ") + ".");
}
