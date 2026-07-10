import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock handles so they're available inside vi.mock() factories.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
const { decodeToMonoF32_16k } = vi.hoisted(() => ({
  decodeToMonoF32_16k: vi.fn(() =>
    Promise.resolve(new Float32Array([0.3, 0.1, -0.2, 0.0, 0.5])),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./audioDecode", () => ({ decodeToMonoF32_16k }));

import { ParakeetProvider } from "./parakeet";
import type { AIProvider } from "./AIProvider";

const DECODED_SAMPLES = new Float32Array([0.3, 0.1, -0.2, 0.0, 0.5]);

const noopProvider: AIProvider = {
  name: "noop",
  transcribe: (_input) => {
    throw new Error("not used");
  },
  cleanup: (_input) => {
    throw new Error("not used");
  },
  health: async () => ({ ok: true, message: "noop" }),
};

describe("ParakeetProvider — invoke contract", () => {
  beforeEach(() => {
    invoke.mockReset();
    decodeToMonoF32_16k.mockReset();
    decodeToMonoF32_16k.mockResolvedValue(DECODED_SAMPLES);
  });

  it("calls transcribe_parakeet with args wrapping variant, pcm array, and null language for 'auto'", async () => {
    invoke.mockResolvedValueOnce({
      text: "this is a test",
      language_detected: "en",
      duration_ms: 850,
    });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "auto",
      cleanupFallback: noopProvider,
    });
    const result = await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    expect(invoke).toHaveBeenCalledOnce();
    const [cmd, payload] = invoke.mock.calls[0] as [
      string,
      { args: { variant: string; pcm: number[]; language: string | null } },
    ];

    // Command name
    expect(cmd).toBe("transcribe_parakeet");

    // Nested args object (Tauri serialised command format)
    expect(payload.args.variant).toBe("v3");
    expect(Array.isArray(payload.args.pcm)).toBe(true);
    expect(payload.args.pcm).toHaveLength(5);
    // "auto" language is sent as null to the Rust command
    expect(payload.args.language).toBeNull();

    // Result mapping
    expect(result.text).toBe("this is a test");
    expect(result.languageDetected).toBe("en");
    expect(result.durationMs).toBe(850);
  });

  it("passes a concrete language code (non-auto) through to the Rust args", async () => {
    invoke.mockResolvedValueOnce({ text: "bonjour", language_detected: "fr", duration_ms: 400 });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "fr",
      cleanupFallback: noopProvider,
    });
    // input.language overrides cfg.language when provided
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]), language: "fr" });

    const [, payload] = invoke.mock.calls[0] as [
      string,
      { args: { language: string | null } },
    ];
    expect(payload.args.language).toBe("fr");
  });

  it("uses the v2 variant when the config says v2", async () => {
    invoke.mockResolvedValueOnce({ text: "hello", language_detected: "en", duration_ms: 300 });

    const provider = new ParakeetProvider({
      variant: "v2",
      language: "en",
      cleanupFallback: noopProvider,
    });
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    const [cmd, payload] = invoke.mock.calls[0] as [
      string,
      { args: { variant: string; language: string | null } },
    ];
    expect(cmd).toBe("transcribe_parakeet");
    expect(payload.args.variant).toBe("v2");
    // "en" is not "auto", so passed through as-is
    expect(payload.args.language).toBe("en");
  });

  it("PCM array values match Array.from() of the decoded samples", async () => {
    invoke.mockResolvedValueOnce({ text: "ok", language_detected: "en", duration_ms: 100 });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "auto",
      cleanupFallback: noopProvider,
    });
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    const [, payload] = invoke.mock.calls[0] as [
      string,
      { args: { pcm: number[] } },
    ];
    const expected = Array.from(DECODED_SAMPLES);
    expect(payload.args.pcm).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(payload.args.pcm[i]).toBeCloseTo(expected[i], 4);
    }
  });

  it("falls back to cfg.language when language_detected is empty", async () => {
    invoke.mockResolvedValueOnce({ text: "hola", language_detected: "", duration_ms: 500 });

    const provider = new ParakeetProvider({
      variant: "v3",
      language: "es",
      cleanupFallback: noopProvider,
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
      cleanupFallback: noopProvider,
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
      cleanupFallback: noopProvider,
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
      cleanupFallback: noopProvider,
    });
    const h = await provider.health();

    expect(h.ok).toBe(false);
    expect(h.message).toMatch(/runtime not installed/i);
  });
});
