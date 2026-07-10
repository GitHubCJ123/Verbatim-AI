import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock handles so they're available inside vi.mock() factories.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
const { decodeToMonoF32_16k } = vi.hoisted(() => ({
  decodeToMonoF32_16k: vi.fn(() =>
    Promise.resolve(new Float32Array([0.1, -0.1, 0.2, -0.2, 0.0])),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./audioDecode", () => ({ decodeToMonoF32_16k }));
vi.mock("../preferences", () => ({ isPerfDebugEnabled: () => false }));

import { LocalWhisperProvider, resetWhisperEngineProbe } from "./localWhisper";

// 5 f32 samples = 20 bytes of PCM payload the mock decoder always returns.
const SAMPLE_COUNT = 5;

// Isolated per-test localStorage backed by a plain Map.
let lsStore: Map<string, string>;

describe("LocalWhisperProvider — invoke contract", () => {
  beforeEach(() => {
    invoke.mockReset();
    decodeToMonoF32_16k.mockReset();
    decodeToMonoF32_16k.mockResolvedValue(
      new Float32Array([0.1, -0.1, 0.2, -0.2, 0.0]),
    );
    resetWhisperEngineProbe();

    // Stub localStorage (absent in Node/vitest default env) with a Map.
    lsStore = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => lsStore.get(k) ?? null,
      setItem: (k: string, v: string) => { lsStore.set(k, v); },
      removeItem: (k: string) => { lsStore.delete(k); },
      clear: () => { lsStore.clear(); },
    });

    // Force the one-shot CLI path so resolveWhisperCommand() returns
    // "transcribe_local_pcm" without probing server availability via invoke.
    lsStore.set("sw.ai.whisperEngine", "cli");
    lsStore.set("sw.ai.whisperCompute", "cpu");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls transcribe_local_pcm with binary PCM payload and correct headers", async () => {
    invoke.mockResolvedValueOnce({
      text: "hello world",
      language_detected: "en",
      duration_ms: 1234,
    });

    const provider = new LocalWhisperProvider({ tier: "turbo" });
    const result = await provider.transcribe({
      audio: new Blob([new Uint8Array(4)]),
      language: "en",
    });

    expect(invoke).toHaveBeenCalledOnce();
    const [cmd, pcmPayload, opts] = invoke.mock.calls[0] as [
      string,
      Uint8Array,
      { headers: Record<string, string> },
    ];

    // Command name
    expect(cmd).toBe("transcribe_local_pcm");

    // Binary PCM payload: SAMPLE_COUNT f32s × 4 bytes each
    expect(pcmPayload).toBeInstanceOf(Uint8Array);
    expect(pcmPayload.byteLength).toBe(SAMPLE_COUNT * 4);

    // IPC headers
    expect(opts.headers["content-type"]).toBe("application/octet-stream");
    expect(opts.headers["x-verbatim-pcm-format"]).toBe("f32le-16000-mono");
    expect(opts.headers["x-verbatim-tier"]).toBe("turbo");
    expect(opts.headers["x-verbatim-language"]).toBe("en");
    expect(opts.headers["x-verbatim-translate"]).toBe("false");
    expect(opts.headers["x-verbatim-compute-preference"]).toBe("cpu");

    // Result mapping
    expect(result.text).toBe("hello world");
    expect(result.languageDetected).toBe("en");
    expect(result.durationMs).toBe(1234);
  });

  it("passes a custom model id verbatim in the x-verbatim-tier header", async () => {
    invoke.mockResolvedValueOnce({ text: "custom", language_detected: "en", duration_ms: 500 });

    const provider = new LocalWhisperProvider({
      tier: "custom:my-model.gguf",
    });
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    const [, , opts] = invoke.mock.calls[0] as [
      string,
      Uint8Array,
      { headers: Record<string, string> },
    ];
    expect(opts.headers["x-verbatim-tier"]).toBe("custom:my-model.gguf");
  });

  it("uses transcribe_local_server_pcm when engine preference is 'server'", async () => {
    lsStore.set("sw.ai.whisperEngine", "server");
    invoke.mockResolvedValueOnce({ text: "warm result", language_detected: "en", duration_ms: 300 });

    const provider = new LocalWhisperProvider({ tier: "turbo" });
    await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    const [cmd] = invoke.mock.calls[0] as [string, ...unknown[]];
    expect(cmd).toBe("transcribe_local_server_pcm");
  });

  it("falls back to input.language when language_detected is empty", async () => {
    invoke.mockResolvedValueOnce({ text: "bonjour", language_detected: "", duration_ms: 600 });

    const provider = new LocalWhisperProvider({ tier: "base" });
    const result = await provider.transcribe({
      audio: new Blob([new Uint8Array(4)]),
      language: "fr",
    });

    expect(result.languageDetected).toBe("fr");
  });

  it("falls back to 'auto' when language_detected is empty and no language was supplied", async () => {
    invoke.mockResolvedValueOnce({ text: "hello", language_detected: "", duration_ms: 400 });

    const provider = new LocalWhisperProvider({ tier: "small" });
    const result = await provider.transcribe({ audio: new Blob([new Uint8Array(4)]) });

    expect(result.languageDetected).toBe("auto");
  });

  // ── Error paths ──────────────────────────────────────────────────────────

  it("propagates an invoke rejection from transcribe()", async () => {
    invoke.mockRejectedValueOnce(new Error("runtime not ready"));

    const provider = new LocalWhisperProvider({ tier: "turbo" });
    await expect(
      provider.transcribe({ audio: new Blob([new Uint8Array(4)]) }),
    ).rejects.toThrow("runtime not ready");
  });

  it("health() returns ok:false with the error message when invoke rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("sidecar missing"));

    const provider = new LocalWhisperProvider({ tier: "turbo" });
    const h = await provider.health();

    expect(h.ok).toBe(false);
    expect(h.message).toContain("sidecar missing");
  });
});
