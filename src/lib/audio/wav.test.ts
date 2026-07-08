import { describe, expect, it } from "vitest";
import { encodeWavBlob } from "./wav";

async function readBytes(blob: Blob): Promise<DataView> {
  const buf = await blob.arrayBuffer();
  return new DataView(buf);
}

const ascii = (view: DataView, offset: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");

describe("encodeWavBlob", () => {
  it("writes a valid 16-bit mono WAV header", async () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWavBlob(pcm, 16000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + pcm.length * 2);

    const v = await readBytes(blob);
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(ascii(v, 8, 4)).toBe("WAVE");
    expect(ascii(v, 12, 4)).toBe("fmt ");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000); // sample rate
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(pcm.length * 2);
  });

  it("clamps and converts samples to int16", async () => {
    const pcm = new Float32Array([0, 1, -1, 2, -2]);
    const v = await readBytes(encodeWavBlob(pcm));
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(0x7fff); // +1 full scale
    expect(v.getInt16(48, true)).toBe(-0x8000); // -1 full scale
    expect(v.getInt16(50, true)).toBe(0x7fff); // +2 clamped
    expect(v.getInt16(52, true)).toBe(-0x8000); // -2 clamped
  });
});
