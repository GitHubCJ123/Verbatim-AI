/**
 * Local cleanup provider that talks to a user-run Ollama server.
 *
 * Ollama exposes an OpenAI-compatible streaming chat endpoint at
 * /v1/chat/completions, so we can reuse the same SSE parsing the cloud
 * provider uses. We never spawn / manage Ollama ourselves — the user
 * installs it from ollama.com and pulls models via `ollama pull <name>`.
 *
 * Important: we use the Tauri HTTP plugin's `fetch` instead of the
 * webview's built-in `fetch`. In production builds Tauri loads the app
 * over `https://tauri.localhost` (Windows) — the webview's
 * mixed-content policy blocks any plain-HTTP request, including
 * `http://localhost:11434`. The plugin makes the request from Rust, so
 * it isn't subject to that policy.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { CLOUD_FEATURES_ENABLED } from "../features";

// Ollama enforces a CORS-style origin allowlist (OLLAMA_ORIGINS).
// In production our webview origin is `https://tauri.localhost`, which
// Ollama rejects with 403 unless the user manually adds it. We avoid
// the check entirely by sending a non-browser User-Agent and dropping
// the Origin header — Ollama only does the check for browser-like
// requests. The Tauri HTTP plugin lets us set arbitrary headers from
// the JS side, so we attach them on every call below.
const OLLAMA_HEADERS: HeadersInit = {
  "user-agent": "verbatim-ai/0.3 (+https://github.com/GitHubCJ123/Verbatim-AI)",
};

function withOllamaHeaders(init?: RequestInit): RequestInit {
  const merged = new Headers(init?.headers ?? {});
  for (const [k, v] of Object.entries(OLLAMA_HEADERS)) merged.set(k, v as string);
  return { ...(init ?? {}), headers: merged };
}

// Wrap so we can confirm in logs that we're using the plugin-backed
// fetch, not the webview's native fetch (which is subject to
// mixed-content blocks against http://localhost in production).
const fetch = (input: string | URL | Request, init?: RequestInit) => {
  if (
    typeof window !== "undefined" &&
    !(window as unknown as { __ollamaFetchLogged?: boolean }).__ollamaFetchLogged
  ) {
    (window as unknown as { __ollamaFetchLogged?: boolean }).__ollamaFetchLogged = true;
    console.info(
      `[ollama:fetch] using @tauri-apps/plugin-http fetch (typeof tauriFetch=${typeof tauriFetch})`,
    );
  }
  return tauriFetch(input, withOllamaHeaders(init));
};
import type {
  AIProvider,
  CleanupInput,
  ProviderHealth,
  TranscribeInput,
  TranscribeResult,
} from "./AIProvider";
import { buildCleanupPrompt } from "./promptBuilder";

const LS_CLEANUP_PROVIDER = "sw.ai.cleanupProvider";
const LS_OLLAMA_HOST = "sw.ai.ollamaHost";
const LS_OLLAMA_MODEL = "sw.ai.ollamaModel";

export type CleanupProviderKind = "cloud" | "local-ollama" | "local-llama-cpp";

export function getCleanupProviderKind(): CleanupProviderKind {
  const v = localStorage.getItem(LS_CLEANUP_PROVIDER);
  if (v === "local-ollama" || v === "local-llama-cpp") return v;
  if (v === "cloud" && CLOUD_FEATURES_ENABLED) return "cloud";
  // Default / cloud-disabled fallback. A stored "cloud" is preserved but
  // resolves to local Ollama while the flag is off.
  return CLOUD_FEATURES_ENABLED ? "cloud" : "local-ollama";
}
export function setCleanupProviderKind(v: CleanupProviderKind): void {
  // Never persist a cloud selection while cloud is disabled; keep any
  // existing stored value intact (non-destructive no-op).
  if (v === "cloud" && !CLOUD_FEATURES_ENABLED) return;
  localStorage.setItem(LS_CLEANUP_PROVIDER, v);
}

/**
 * Effective cleanup engine for an already-resolved kind (global setting
 * or per-Mode override). Coerces "cloud" → local while cloud is disabled.
 * Shared by provider resolution (ai/index.ts) and the privacy indicator.
 */
export function effectiveCleanupKind(kind: CleanupProviderKind): CleanupProviderKind {
  return !CLOUD_FEATURES_ENABLED && kind === "cloud" ? "local-ollama" : kind;
}

export function getOllamaHost(): string {
  return localStorage.getItem(LS_OLLAMA_HOST) || "http://localhost:11434";
}
export function setOllamaHost(v: string): void {
  localStorage.setItem(LS_OLLAMA_HOST, v);
}

export function getOllamaModel(): string {
  return localStorage.getItem(LS_OLLAMA_MODEL) || "";
}
export function setOllamaModel(v: string): void {
  localStorage.setItem(LS_OLLAMA_MODEL, v);
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

/**
 * Curated suggestion list shown in Settings. Tags must match what
 * Ollama exposes in its registry. Sizes are approximate Q4_K_M defaults
 * for the bundled quant — actual download size can differ a touch.
 *
 * Snapshot of ollama.com/library as of mid-2026. Bump when models
 * meaningfully change ranking. Models tagged `cloud` only on Ollama
 * are intentionally excluded — we only suggest things users can fully
 * run locally.
 */
export interface SuggestedModel {
  tag: string;
  label: string;
  approxDiskMB: number;
  approxVramMB: number;
  blurb: string;
  recommended?: boolean;
}

export const SUGGESTED_OLLAMA_MODELS: SuggestedModel[] = [
  // ---- Small (laptops, low-VRAM) ----
  {
    tag: "qwen3.5:2b",
    label: "Qwen 3.5 — 2B",
    approxDiskMB: 1500,
    approxVramMB: 2400,
    blurb: "Tiny but capable. Runs on any laptop, fastest cleanup.",
  },
  {
    tag: "llama3.2:3b",
    label: "Llama 3.2 — 3B",
    approxDiskMB: 2000,
    approxVramMB: 3000,
    blurb: "Meta's small all-rounder. Good for low-VRAM machines.",
  },
  {
    tag: "gemma3:4b",
    label: "Gemma 3 — 4B",
    approxDiskMB: 3000,
    approxVramMB: 4000,
    blurb: "Google. Fast, decent quality. Solid laptop pick.",
  },
  {
    tag: "qwen3.5:4b",
    label: "Qwen 3.5 — 4B",
    approxDiskMB: 2500,
    approxVramMB: 3500,
    blurb: "Best small Qwen for laptops. Strong instruction-following.",
    recommended: true,
  },

  // ---- Mid (the sweet spot) ----
  {
    tag: "qwen3.5:9b",
    label: "Qwen 3.5 — 9B",
    approxDiskMB: 5500,
    approxVramMB: 7000,
    blurb: "Current sweet spot for cleanup on a modern GPU. Newest Qwen, editing-friendly.",
  },
  {
    tag: "llama3.1:8b",
    label: "Llama 3.1 — 8B",
    approxDiskMB: 4700,
    approxVramMB: 6000,
    blurb: "Meta's safe default. Good general-purpose pick.",
  },
  {
    tag: "gemma3:12b",
    label: "Gemma 3 — 12B",
    approxDiskMB: 7000,
    approxVramMB: 9000,
    blurb: "Larger Gemma. Quality jump if you have ≥10 GB VRAM.",
  },
  {
    tag: "qwen3:14b",
    label: "Qwen 3 — 14B",
    approxDiskMB: 9000,
    approxVramMB: 11000,
    blurb: "Top pick if you have ≥12 GB VRAM. Near closed-model quality.",
  },

  // ---- Large (5080 / 5090 / workstation) ----
  {
    tag: "qwen3.5:27b",
    label: "Qwen 3.5 — 27B",
    approxDiskMB: 17000,
    approxVramMB: 20000,
    blurb: "Newest big Qwen. Excellent. Needs 22 GB+ VRAM.",
  },
  {
    tag: "gemma4:31b",
    label: "Gemma 4 — 31B",
    approxDiskMB: 20000,
    approxVramMB: 22000,
    blurb: "Google's latest local Gemma 4. 256K context, frontier-class quality. Needs 24 GB VRAM.",
  },
  {
    tag: "llama3.3:70b",
    label: "Llama 3.3 — 70B",
    approxDiskMB: 43000,
    approxVramMB: 48000,
    blurb: "Cloud-quality output. Needs serious GPU (5090 / A100). ~6 tok/s typical.",
  },
];

function normalizeHost(host?: string): string {
  return (host || getOllamaHost()).replace(/\/+$/, "");
}

export async function listOllamaModels(host?: string): Promise<OllamaModelInfo[]> {
  const url = `${normalizeHost(host)}/api/tags`;
  console.info(`[ollama:list] GET ${url}`);
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ollama:list] fetch threw: ${msg}`);
    throw new Error(`Couldn't reach Ollama at ${normalizeHost(host)}: ${msg}`);
  }
  console.info(`[ollama:list] ${url} -> HTTP ${res.status}`);
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const data = (await res.json()) as {
    models?: Array<{ name: string; size: number; modified_at: string }>;
  };
  console.info(`[ollama:list] ${data.models?.length ?? 0} models pulled`);
  return (data.models ?? []).map((m) => ({
    name: m.name,
    sizeBytes: m.size,
    modifiedAt: m.modified_at,
  }));
}

export type PingResult =
  | { kind: "ok" }
  | { kind: "forbidden"; status: number } // 403 etc. — origin block
  | { kind: "http-error"; status: number }
  | { kind: "unreachable"; message: string };

export async function pingOllama(host?: string): Promise<PingResult> {
  const url = `${normalizeHost(host)}/api/tags`;
  console.info(`[ollama:ping] GET ${url}`);
  try {
    const res = await fetch(url, { method: "GET" });
    console.info(`[ollama:ping] ${url} -> HTTP ${res.status} ${res.statusText}`);
    if (res.ok) return { kind: "ok" };
    if (res.status === 403) return { kind: "forbidden", status: res.status };
    const body = await res.text().catch(() => "");
    console.warn(`[ollama:ping] body (first 200): ${body.slice(0, 200)}`);
    return { kind: "http-error", status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ollama:ping] fetch threw: ${msg}`);
    return { kind: "unreachable", message: msg };
  }
}

/** Backwards-compatible boolean wrapper. */
export async function isOllamaReachable(host?: string): Promise<boolean> {
  return (await pingOllama(host)).kind === "ok";
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/**
 * Stream a model pull from Ollama. Calls `onProgress` for each NDJSON
 * line and resolves when the stream ends or status reports success.
 * Throws if Ollama is unreachable or rejects the pull request.
 */
export async function pullOllamaModel(
  name: string,
  host: string | undefined,
  onProgress: (p: PullProgress) => void,
): Promise<void> {
  const url = `${normalizeHost(host)}/api/pull`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, stream: true }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't reach Ollama: ${msg}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama pull ${res.status}: ${text.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line) as PullProgress & { error?: string };
        if (j.error) throw new Error(j.error);
        onProgress(j);
      } catch (e) {
        if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) {
          throw e;
        }
        // skip malformed lines
      }
    }
  }
}

export interface OllamaConfig {
  host: string;
  model: string;
}

export class OllamaProvider implements AIProvider {
  readonly name: string;

  constructor(private cfg: OllamaConfig) {
    this.name = `Ollama (${cfg.model || "no model"})`;
  }

  async transcribe(_input: TranscribeInput): Promise<TranscribeResult> {
    throw new Error("Ollama does not support transcription.");
  }

  async *cleanup(input: CleanupInput): AsyncIterable<string> {
    if (!this.cfg.model) {
      throw new Error("No Ollama model selected. Pick one in Settings → AI model.");
    }
    const { system, user } = buildCleanupPrompt(input);
    // We hit Ollama's NATIVE /api/chat endpoint rather than the
    // OpenAI-compatible /v1/chat/completions shim because the docs only
    // document `think: false` against /api/chat — on the OpenAI shim the
    // flag may be silently dropped, leaving thinking enabled by default
    // for Qwen 3 / 3.5 / Gemma 4 (very slow).
    // https://docs.ollama.com/capabilities/thinking
    const url = `${this.cfg.host.replace(/\/+$/, "")}/api/chat`;
    const body = {
      model: this.cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
      // Disable chain-of-thought reasoning. Cleanup is short and we want
      // the polished answer directly. Models without thinking mode just
      // ignore this field.
      think: false,
      options: {
        temperature: input.temperature ?? 0.3,
      },
    };
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Couldn't reach Ollama at ${this.cfg.host}. Is it running? (${msg})`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
    }

    const started = performance.now();
    let firstTokenAt: number | null = null;
    let contentBytes = 0;
    let thinkingBytes = 0;
    let chunks = 0;
    try {
      for await (const piece of parseOllamaNDJSONInstrumented(res.body, (kind, n) => {
        if (kind === "content") {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          contentBytes += n;
        } else if (kind === "thinking") {
          thinkingBytes += n;
        }
        chunks += 1;
      })) {
        yield piece;
      }
    } finally {
      const total = Math.round(performance.now() - started);
      const ttft = firstTokenAt ? Math.round(firstTokenAt - started) : null;
      console.info(
        `[ollama:cleanup] model=${this.cfg.model} ttft=${ttft}ms total=${total}ms content=${contentBytes}B thinking=${thinkingBytes}B chunks=${chunks}`,
      );
      if (thinkingBytes > 0) {
        console.warn(
          `[ollama:cleanup] model emitted ${thinkingBytes}B of thinking tokens despite think:false — Ollama may not be honoring the flag for ${this.cfg.model}.`,
        );
      }
    }
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    const reachable = await pingOllama(this.cfg.host);
    const latencyMs = Math.round(performance.now() - start);
    if (!reachable) {
      return { ok: false, message: `Can't reach Ollama at ${this.cfg.host}` };
    }
    if (!this.cfg.model) {
      return { ok: false, message: "No model selected" };
    }
    return {
      ok: true,
      message: `Ollama ready (${this.cfg.model})`,
      latencyMs,
    };
  }
}

async function* parseOllamaNDJSONInstrumented(
  body: ReadableStream<Uint8Array>,
  onPiece: (kind: "content" | "thinking", bytes: number) => void,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const json = JSON.parse(line) as {
          message?: { content?: string; thinking?: string };
          done?: boolean;
          error?: string;
        };
        if (json.error) throw new Error(json.error);
        const thinking = json.message?.thinking;
        if (thinking) onPiece("thinking", thinking.length);
        const chunk = json.message?.content;
        if (chunk) {
          onPiece("content", chunk.length);
          yield chunk;
        }
        if (json.done) return;
      } catch (e) {
        if (e instanceof Error && !e.message.startsWith("Unexpected")) throw e;
        // skip malformed lines
      }
    }
  }
}
