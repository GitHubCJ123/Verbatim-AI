import { describe, expect, it, vi } from "vitest";
import { wer } from "../../test/wer";

declare const process: { env: Record<string, string | undefined> };

interface FsLike {
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: "utf8"): string;
}

const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as FsLike;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  disable: vi.fn(),
  enable: vi.fn(),
  isEnabled: vi.fn(),
}));
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

installLocalStorageShim();

const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

if (url && key) {
  Object.assign(import.meta.env, {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: key,
  });
}

const { SupabaseAIProvider } = await import("./index");

describe.skipIf(!url || !key)("Supabase cloud AI (real)", () => {
  it("transcribes hello-world audio within WER tolerance", async () => {
    const provider = new SupabaseAIProvider();
    const audio = new Blob([fs.readFileSync("fixtures/hello-world.16k.wav")], {
      type: "audio/wav",
    });

    const res = await provider.transcribe({ audio });

    expect(wer("hello world this is a test of the transcription engine", res.text)).toBeLessThan(
      0.15,
    );
  });

  it("strips disfluencies during cleanup", async () => {
    const provider = new SupabaseAIProvider();
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
  });
});
