import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock handles so they're available inside vi.mock() factories.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
const { decodeToMonoF32_16k } = vi.hoisted(() => ({
  decodeToMonoF32_16k: vi.fn(() =>
    Promise.resolve(new Float32Array([0.3, 0.1, -0.2, 0.0, 0.5])),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./audioDecode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audioDecode")>();
  return {
    ...actual,
    decodeToMonoF32_16k,
    pcm16kFor: (input: { audio: Blob; pcm?: Float32Array }) =>
      input.pcm ? Promise.resolve(input.pcm) : decodeToMonoF32_16k(),
  };
});

import { ParakeetProvider } from "./parakeet";

const DECODED_SAMPLES = new Float32Array([0.3, 0.1, -0.2, 0.0, 0.5]);

describe("ParakeetProvider — invoke contract", () => {
  beforeEach(() => {
    invoke.mockReset();
    decodeToMonoF32_16k.mockReset();
    decodeToMonoF32_16k.mockResolvedValue(DECODED_SAMPLES);
  });

  type RawCall = [string, Uint8Array, { headers: Record<string, string> }];

  function decodeBody(body: Uint8Array): number[] {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    return Array.from({ length: body.byteLength / 4 }, (_, i) => view.getFloat32(i * 4, true));
  }

  it("sends raw f32 PCM to transcribe_parakeet_pcm with variant/language headers", async () => {
    invoke.mockResolvedValueOnce({
      text: "this is a test",
      language_detected: "en",
      duration_ms: 850,
    });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "auto",
    });
    const result = await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    expect(invoke).toHaveBeenCalledOnce();
    const [cmd, body, opts] = invoke.mock.calls[0] as RawCall;
    expect(cmd).toBe("transcribe_parakeet_pcm");
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body.byteLength).toBe(DECODED_SAMPLES.length * 4);
    expect(opts.headers["x-verbatim-pcm-format"]).toBe("f32le-16000-mono");
    expect(opts.headers["x-verbatim-parakeet-variant"]).toBe("v3");
    // "auto" is sent as an empty language header.
    expect(opts.headers["x-verbatim-language"]).toBe("");

    expect(result.text).toBe("this is a test");
    expect(result.languageDetected).toBe("en");
    expect(result.durationMs).toBe(850);
  });

  it("passes a concrete language code (non-auto) through in the header", async () => {
    invoke.mockResolvedValueOnce({ text: "bonjour", language_detected: "fr", duration_ms: 400 });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "fr",
    });
    // input.language overrides cfg.language when provided
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]), language: "fr" });

    const [, , opts] = invoke.mock.calls[0] as RawCall;
    expect(opts.headers["x-verbatim-language"]).toBe("fr");
  });

  it("uses the v2 variant when the config says v2", async () => {
    invoke.mockResolvedValueOnce({ text: "hello", language_detected: "en", duration_ms: 300 });

    const provider = new ParakeetProvider({
      variant: "v2",
      language: "en",
    });
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    const [cmd, , opts] = invoke.mock.calls[0] as RawCall;
    expect(cmd).toBe("transcribe_parakeet_pcm");
    expect(opts.headers["x-verbatim-parakeet-variant"]).toBe("v2");
    expect(opts.headers["x-verbatim-language"]).toBe("en");
  });

  it("PCM bytes decode back to the decoded samples", async () => {
    invoke.mockResolvedValueOnce({ text: "ok", language_detected: "en", duration_ms: 100 });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "auto",
    });
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    const [, body] = invoke.mock.calls[0] as RawCall;
    const decoded = decodeBody(body);
    const expected = Array.from(DECODED_SAMPLES);
    expect(decoded).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(decoded[i]).toBeCloseTo(expected[i], 4);
    }
  });

  it("uses caller-supplied PCM without decoding the blob", async () => {
    invoke.mockResolvedValueOnce({ text: "ok", language_detected: "en", duration_ms: 100 });
    const provider = new ParakeetProvider({ variant: "v3", language: "auto" });
    const pcm = new Float32Array([0.25, -0.5]);
    await provider.transcribe({ audio: new Blob([]), pcm });

    expect(decodeToMonoF32_16k).not.toHaveBeenCalled();
    const [, body] = invoke.mock.calls[0] as RawCall;
    expect(decodeBody(body)).toEqual([0.25, -0.5]);
  });

  it("falls back to cfg.language when language_detected is empty", async () => {
    invoke.mockResolvedValueOnce({ text: "hola", language_detected: "", duration_ms: 500 });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "es",
    });
    const result = await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    expect(result.languageDetected).toBe("es");
  });

  // ── Error paths ──────────────────────────────────────────────────────────

  it("propagates an invoke rejection from transcribe()", async () => {
    invoke.mockRejectedValueOnce(new Error("model not loaded"));

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "auto",
    });
    await expect(
      provider.transcribe({ audio: new Blob([new Uint8Array(4)]) }),
    ).rejects.toThrow("model not loaded");
  });

  it("health() returns ok:false when invoke rejects during the runtime check", async () => {
    // Promise.all fires both invokes concurrently; give the model check a
    // valid response so only the runtime-check rejection reaches the catch.
    invoke.mockRejectedValueOnce(new Error("sherpa-onnx missing")); // isParakeetRuntimeInstalled
    invoke.mockResolvedValueOnce({ variant: "v3", installed: false, size_bytes: 0 }); // isParakeetModelInstalled

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "auto",
    });
    const h = await provider.health();

    expect(h.ok).toBe(false);
    expect(h.message).toContain("sherpa-onnx missing");
  });

  it("health() reports not-ok when runtime is not installed", async () => {
    // health() uses Promise.all — both invoke calls must be satisfied.
    invoke.mockResolvedValueOnce(false); // isParakeetRuntimeInstalled → false
    invoke.mockResolvedValueOnce({ variant: "v3", installed: true, size_bytes: 655_360_000 }); // isParakeetModelInstalled

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "auto",
    });
    const h = await provider.health();

    expect(h.ok).toBe(false);
    expect(h.message).toMatch(/runtime not installed/i);
  });
});
