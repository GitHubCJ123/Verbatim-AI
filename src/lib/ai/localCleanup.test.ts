import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  CLEANUP_MODELS,
  DEFAULT_CLEANUP_MODEL,
  LocalCleanupProvider,
  getCleanupModel,
  getCleanupProviderKind,
  normalizeCleanupKind,
  setCleanupModel,
  setCleanupProviderKind,
} from "./localCleanup";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  invoke.mockReset();
});

describe("cleanup settings", () => {
  it("defaults to the built-in engine and the recommended model", () => {
    expect(getCleanupProviderKind()).toBe("local");
    expect(getCleanupModel()).toBe(DEFAULT_CLEANUP_MODEL);
    expect(CLEANUP_MODELS.find((m) => m.recommended)?.id).toBe(DEFAULT_CLEANUP_MODEL);
  });

  it("reads older Ollama and llama.cpp choices as the built-in engine without rewriting them", () => {
    for (const legacy of ["local-ollama", "local-llama-cpp"]) {
      localStorage.setItem("sw.ai.cleanupProvider", legacy);
      expect(getCleanupProviderKind()).toBe("local");
      expect(localStorage.getItem("sw.ai.cleanupProvider")).toBe(legacy);
    }
  });

  it("keeps a stored cloud choice intact while cloud is disabled", () => {
    localStorage.setItem("sw.ai.cleanupProvider", "cloud");
    expect(getCleanupProviderKind()).toBe("local");
    setCleanupProviderKind("cloud");
    expect(localStorage.getItem("sw.ai.cleanupProvider")).toBe("cloud");
  });

  it("ignores unknown stored model ids", () => {
    localStorage.setItem("sw.ai.cleanupModel", "qwen3.5:2b");
    expect(getCleanupModel()).toBe(DEFAULT_CLEANUP_MODEL);
    setCleanupModel("qwen3.5-4b");
    expect(getCleanupModel()).toBe("qwen3.5-4b");
  });

  it("normalizes provider kinds", () => {
    expect(normalizeCleanupKind("cloud")).toBe("cloud");
    expect(normalizeCleanupKind("local-ollama")).toBe("local");
    expect(normalizeCleanupKind(null)).toBeNull();
    expect(normalizeCleanupKind("something-else")).toBeNull();
  });

  it("publishes scores on a 0-10 scale with the figures behind them", () => {
    for (const m of CLEANUP_MODELS) {
      expect(m.quality).toBeGreaterThanOrEqual(0);
      expect(m.quality).toBeLessThanOrEqual(10);
      expect(m.speed).toBeGreaterThan(0);
      expect(m.speed).toBeLessThanOrEqual(10);
      expect(m.checksPassed).toBeLessThanOrEqual(m.checksTotal);
    }
  });
});

describe("LocalCleanupProvider", () => {
  it("sends chat messages and a bounded token budget to the native engine", async () => {
    invoke.mockResolvedValueOnce("Send it to Jane.");
    const provider = new LocalCleanupProvider("qwen3.5-2b");
    const chunks: string[] = [];
    for await (const c of provider.cleanup({
      rawText: "send it to john sorry to jane",
      systemPrompt: "",
      modeName: "Default",
      lightCleanup: true,
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual(["Send it to Jane."]);
    const [command, payload] = invoke.mock.calls[0];
    expect(command).toBe("cleanup_text");
    expect(payload.args.model).toBe("qwen3.5-2b");
    expect(payload.args.messages[payload.args.messages.length - 1].content).toBe(
      "<transcript>send it to john sorry to jane</transcript>",
    );
    expect(payload.args.maxTokens).toBeLessThan(200);
  });

  it("reports a missing model as not ready without starting the engine", async () => {
    invoke.mockResolvedValueOnce({
      runtimeInstalled: true,
      models: [{ id: "qwen3.5-2b", installed: false, sizeBytes: 1 }],
    });
    const health = await new LocalCleanupProvider("qwen3.5-2b").health();
    expect(health.ok).toBe(false);
    expect(health.message).toContain("isn't downloaded");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
