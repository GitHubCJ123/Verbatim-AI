import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist the invoke mock so it is available inside vi.mock() factories.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { LlamaCppProvider } from "./llamaCpp";

const MODEL_ID = "ggml-org/gemma-3-1b-it-GGUF";

/** Collect all tokens emitted by the cleanup AsyncIterable into a string. */
async function collectCleanup(
  it: AsyncIterable<string>,
): Promise<string> {
  let out = "";
  for await (const chunk of it) out += chunk;
  return out;
}

describe("LlamaCppProvider — invoke contract", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("calls cleanup_llama_cpp with args wrapping model, prompt, temperature, and maxTokens", async () => {
    invoke.mockResolvedValueOnce("This is the polished text.");

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    const output = await collectCleanup(
      provider.cleanup({
        rawText: "um hello world",
        systemPrompt: "Format as plain prose.",
        modeName: "General",
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    const [cmd, payload] = invoke.mock.calls[0] as [
      string,
      { args: { model: string; prompt: string; temperature: number; maxTokens: number } },
    ];

    // Command name
    expect(cmd).toBe("cleanup_llama_cpp");

    // Nested args object
    expect(payload.args.model).toBe(MODEL_ID);
    expect(typeof payload.args.prompt).toBe("string");
    expect(payload.args.prompt.length).toBeGreaterThan(0);
    expect(payload.args.temperature).toBe(0.3); // default
    expect(payload.args.maxTokens).toBe(768);

    // The single yield maps to the full invoke result
    expect(output).toBe("This is the polished text.");
  });

  it("prompt contains the raw transcript and the mode name", async () => {
    invoke.mockResolvedValueOnce("polished");

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    await collectCleanup(
      provider.cleanup({
        rawText: "uh the quick brown fox",
        systemPrompt: "Be concise.",
        modeName: "QuickNote",
      }),
    );

    const [, payload] = invoke.mock.calls[0] as [
      string,
      { args: { prompt: string } },
    ];
    expect(payload.args.prompt).toContain("uh the quick brown fox");
    expect(payload.args.prompt).toContain("QuickNote");
  });

  it("forwards a custom temperature from CleanupInput", async () => {
    invoke.mockResolvedValueOnce("output");

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    await collectCleanup(
      provider.cleanup({
        rawText: "test",
        systemPrompt: "Keep it short.",
        modeName: "Test",
        temperature: 0.7,
      }),
    );

    const [, payload] = invoke.mock.calls[0] as [
      string,
      { args: { temperature: number } },
    ];
    expect(payload.args.temperature).toBe(0.7);
  });

  it("yields the exact string returned by invoke (single chunk)", async () => {
    const expected = "Carefully polished output from the model.";
    invoke.mockResolvedValueOnce(expected);

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    const output = await collectCleanup(
      provider.cleanup({
        rawText: "some raw text",
        systemPrompt: "Polish it.",
        modeName: "General",
      }),
    );

    expect(output).toBe(expected);
  });

  // ── Error paths ──────────────────────────────────────────────────────────

  it("throws before invoking when no model is configured", async () => {
    const provider = new LlamaCppProvider({ model: "" });
    await expect(
      collectCleanup(
        provider.cleanup({
          rawText: "hello",
          systemPrompt: "Do something.",
          modeName: "General",
        }),
      ),
    ).rejects.toThrow("No llama.cpp model selected");

    // invoke must NOT have been called
    expect(invoke).not.toHaveBeenCalled();
  });

  it("propagates an invoke rejection from cleanup()", async () => {
    invoke.mockRejectedValueOnce(new Error("inference failed"));

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    await expect(
      collectCleanup(
        provider.cleanup({
          rawText: "test",
          systemPrompt: "Polish.",
          modeName: "General",
        }),
      ),
    ).rejects.toThrow("inference failed");
  });

  it("health() returns ok:false when the runtime check invoke rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("llama.cpp binary missing"));

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    const h = await provider.health();

    expect(h.ok).toBe(false);
    expect(h.message).toContain("llama.cpp binary missing");
  });

  it("health() returns ok:false when the runtime is not installed", async () => {
    invoke.mockResolvedValueOnce(false); // is_llama_cpp_runtime_installed → false

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    const h = await provider.health();

    expect(h.ok).toBe(false);
    expect(h.message).toMatch(/runtime is not installed/i);
  });

  it("health() returns ok:true when the runtime is installed and a model is set", async () => {
    invoke.mockResolvedValueOnce(true); // is_llama_cpp_runtime_installed → true

    const provider = new LlamaCppProvider({ model: MODEL_ID });
    const h = await provider.health();

    expect(h.ok).toBe(true);
    expect(h.message).toContain(MODEL_ID);
  });

});
