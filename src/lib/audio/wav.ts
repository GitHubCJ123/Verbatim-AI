/**
 * Minimal WAV (PCM16 LE) encoder.
 *
 * Used to re-package trimmed 16 kHz mono Float32 PCM back into an audio
 * Blob so the trimmed clip can flow through the existing provider
 * pipeline unchanged (every on-device provider decodes the Blob via
 * `decodeToMonoF32_16k`, and `decodeAudioData` handles WAV natively).
 *
 * Spec: docs/proposals/handy-adoption.md §Phase 4 (post-hoc trim needs a
 * way to hand the trimmed PCM back to the engine).
 */

/** Clamp a float sample to the int16 range and convert. */
function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

/**
 * Encode mono Float32 PCM to a 16-bit PCM WAV `Blob`.
 *
 * @param pcm         mono samples in [-1, 1]
 * @param sampleRate  sample rate of `pcm` (default 16000)
 */
export function encodeWavBlob(pcm: Float32Array, sampleRate = 16000): Blob {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  // fmt chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  // data chunk
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    view.setInt16(offset, floatToInt16(pcm[i]), true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}
