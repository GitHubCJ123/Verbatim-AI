/**
 * Local cleanup provider that talks to a user-run `llama.cpp` server
 * (`llama-server`).
 *
 * `llama-server` exposes the same OpenAI-compatible streaming chat
 * endpoint at `/v1/chat/completions` as our cloud proxy, so we reuse the
 * shared SSE parser / request helper in `openaiCompat.ts`. We never spawn
 * or manage `llama-server` ourselves — the user builds/installs it from
 * ggml-org/llama.cpp and launches it pointing at a plain GGUF file.
 *
 * Like the Ollama provider we use the Tauri HTTP plugin's `fetch` rather
 * than the webview's built-in `fetch`. In production builds Tauri serves
 * the app over `https://tauri.localhost`, and the webview's mixed-content
 * policy blocks plain-HTTP requests such as `http://127.0.0.1:8080`. The
 * plugin issues the request from Rust, so it isn't subject to that policy.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  AIProvider,
  CleanupInput,
  ProviderHealth,
  TranscribeInput,
  TranscribeResult,
} from "./AIProvider";
import { buildCleanupPrompt } from "./promptBuilder";
import { streamOpenAIChatCompletion, type FetchLike } from "./openaiCompat";
import type { PingResult } from "./ollama";

const LS_LLAMACPP_BASE_URL = "sw.ai.llamacppBaseUrl";
const LS_LLAMACPP_MODEL = "sw.ai.llamacppModel";
const LS_LLAMACPP_API_KEY = "sw.ai.llamacppApiKey";

export const DEFAULT_LLAMACPP_BASE_URL = "http://127.0.0.1:8080";

export function getLlamaCppBaseUrl(): string {
  return localStorage.getItem(LS_LLAMACPP_BASE_URL) || DEFAULT_LLAMACPP_BASE_URL;
}
export function setLlamaCppBaseUrl(v: string): void {
  localStorage.setItem(LS_LLAMACPP_BASE_URL, v);
}

export function getLlamaCppModel(): string {
  return localStorage.getItem(LS_LLAMACPP_MODEL) || "";
}
export function setLlamaCppModel(v: string): void {
  localStorage.setItem(LS_LLAMACPP_MODEL, v);
}

export function getLlamaCppApiKey(): string {
  return localStorage.getItem(LS_LLAMACPP_API_KEY) || "";
}
export function setLlamaCppApiKey(v: string): void {
  localStorage.setItem(LS_LLAMACPP_API_KEY, v);
}

export interface LlamaCppModelInfo {
  id: string;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || getLlamaCppBaseUrl()).replace(/\/+$/, "");
}

function authHeaders(apiKey?: string): Record<string, string> {
  const key = apiKey ?? getLlamaCppApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Wrap the Tauri plugin fetch so we can confirm in logs that we're not
// using the webview's native fetch (which is subject to mixed-content
// blocks against http://localhost in production builds).
const fetchImpl: FetchLike = (input, init) => {
  if (
    typeof window !== "undefined" &&
    !(window as unknown as { __llamacppFetchLogged?: boolean }).__llamacppFetchLogged
  ) {
    (window as unknown as { __llamacppFetchLogged?: boolean }).__llamacppFetchLogged = true;
    console.info(
      `[llamacpp:fetch] using @tauri-apps/plugin-http fetch (typeof tauriFetch=${typeof tauriFetch})`,
    );
  }
  return tauriFetch(input, init);
};

/**
 * Ping `llama-server` by hitting its OpenAI-compatible `/v1/models`
 * endpoint. Reuses the Ollama `PingResult` shape; for llama.cpp a 401
 * (bad / missing API key) surfaces as `forbidden`.
 */
export async function pingLlamaCpp(
  baseUrl?: string,
  apiKey?: string,
): Promise<PingResult> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/models`;
  console.info(`[llamacpp:ping] GET ${url}`);
  try {
    const res = await fetchImpl(url, { method: "GET", headers: authHeaders(apiKey) });
    console.info(`[llamacpp:ping] ${url} -> HTTP ${res.status} ${res.statusText}`);
    if (res.ok) return { kind: "ok" };
    if (res.status === 401 || res.status === 403) {
      return { kind: "forbidden", status: res.status };
    }
    const body = await res.text().catch(() => "");
    console.warn(`[llamacpp:ping] body (first 200): ${body.slice(0, 200)}`);
    return { kind: "http-error", status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[llamacpp:ping] fetch threw: ${msg}`);
    return { kind: "unreachable", message: msg };
  }
}

/** Backwards-compatible boolean wrapper. */
export async function isLlamaCppReachable(baseUrl?: string, apiKey?: string): Promise<boolean> {
  return (await pingLlamaCpp(baseUrl, apiKey)).kind === "ok";
}

/**
 * List models advertised by `llama-server` via `/v1/models`. Usually a
 * single entry (the loaded GGUF), but we return the full list.
 */
export async function listLlamaCppModels(
  baseUrl?: string,
  apiKey?: string,
): Promise<LlamaCppModelInfo[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/v1/models`;
  console.info(`[llamacpp:list] GET ${url}`);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: authHeaders(apiKey) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[llamacpp:list] fetch threw: ${msg}`);
    throw new Error(`Couldn't reach llama-server at ${normalizeBaseUrl(baseUrl)}: ${msg}`);
  }
  console.info(`[llamacpp:list] ${url} -> HTTP ${res.status}`);
  if (!res.ok) throw new Error(`llama-server /v1/models returned ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => ({ id }));
}

export interface LlamaCppConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class LlamaCppProvider implements AIProvider {
  readonly name: string;

  constructor(private cfg: LlamaCppConfig) {
    this.name = `llama.cpp (${cfg.model || "server default"})`;
  }

  async transcribe(_input: TranscribeInput): Promise<TranscribeResult> {
    throw new Error("llama.cpp does not support transcription.");
  }

  async *cleanup(input: CleanupInput): AsyncIterable<string> {
    const { system, user } = buildCleanupPrompt(input);
    const started = performance.now();
    let firstTokenAt: number | null = null;
    let contentBytes = 0;
    let chunks = 0;
    try {
      for await (const piece of streamOpenAIChatCompletion({
        baseUrl: this.cfg.baseUrl,
        model: this.cfg.model,
        apiKey: this.cfg.apiKey,
        system,
        user,
        temperature: input.temperature ?? 0.3,
        fetchImpl,
        providerLabel: "llama-server",
      })) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        contentBytes += piece.length;
        chunks += 1;
        yield piece;
      }
    } finally {
      const total = Math.round(performance.now() - started);
      const ttft = firstTokenAt ? Math.round(firstTokenAt - started) : null;
      console.info(
        `[llamacpp:cleanup] model=${this.cfg.model || "(default)"} ttft=${ttft}ms total=${total}ms content=${contentBytes}B chunks=${chunks}`,
      );
    }
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    const ping = await pingLlamaCpp(this.cfg.baseUrl, this.cfg.apiKey);
    const latencyMs = Math.round(performance.now() - start);
    if (ping.kind !== "ok") {
      const detail =
        ping.kind === "forbidden"
          ? `rejected the request (HTTP ${ping.status}) — check the API key`
          : ping.kind === "http-error"
            ? `returned HTTP ${ping.status}`
            : "is not reachable";
      return { ok: false, message: `llama-server at ${this.cfg.baseUrl} ${detail}` };
    }
    return {
      ok: true,
      message: `llama.cpp ready${this.cfg.model ? ` (${this.cfg.model})` : ""}`,
      latencyMs,
    };
  }
}
