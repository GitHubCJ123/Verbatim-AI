import { describe, expect, it, vi } from "vitest";

declare const process: { env: Record<string, string | undefined> };

interface FsLike {
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: "utf8"): string;
}

const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as FsLike;

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
}));

function installLocalStorageShim(): void {
  if ("localStorage" in globalThis) return;

  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

installLocalStorageShim();

const ollamaUp = await fetch("http://127.0.0.1:11434/api/tags")
  .then((r) => r.ok)
  .catch(() => false);
const ollamaTags = ollamaUp
  ? await fetch("http://127.0.0.1:11434/api/tags")
      .then((r) => r.json() as Promise<OllamaTagsResponse>)
      .catch((): OllamaTagsResponse => ({}))
  : undefined;
const ollamaModel = process.env.OLLAMA_MODEL ?? ollamaTags?.models?.[0]?.name ?? "llama3.2";

localStorage.setItem("sw.ai.ollamaHost", "http://127.0.0.1:11434");
localStorage.setItem("sw.ai.ollamaModel", ollamaModel);

const { OllamaProvider, getOllamaHost, getOllamaModel } = await import("./ollama");

describe.skipIf(!ollamaUp)("Ollama cleanup (real)", () => {
  it(
    "strips disfluencies",
    async () => {
      const provider = new OllamaProvider({
        host: getOllamaHost(),
        model: getOllamaModel(),
      });
      const rawText = fs.readFileSync("fixtures/messy-transcript.txt", "utf8");

      const cleaned = await collect(
        provider.cleanup({
          rawText,
          systemPrompt:
            "Clean up this dictated text: fix punctuation and remove filler words. Return only the cleaned text.",
          modeName: "Default",
        }),
      );

      expect(cleaned).toMatch(/hello world/i);
      expect(cleaned).not.toMatch(/\b(um|uh|like|you know)\b/i);
    },
    20_000,
  );
});
