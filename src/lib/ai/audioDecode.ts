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
