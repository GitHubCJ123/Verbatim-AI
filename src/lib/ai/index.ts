/**
 * Calls the Supabase Edge Functions that proxy Azure AI Foundry.
 * The user's session JWT is attached so the functions can run under
 * an authenticated context (RLS for any auxiliary DB reads).
 */
import {
  type AIProvider,
  type CleanupInput,
  type ProviderHealth,
  type TranscribeInput,
  type TranscribeResult,
} from "./AIProvider";
import { supabase, supabaseAnonKey, supabaseUrl } from "../supabase";

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in.");
  return {
    Authorization: `Bearer ${token}`,
    apikey: supabaseAnonKey(),
  };
}

function functionUrl(name: string): string {
  return `${supabaseUrl().replace(/\/+$/, "")}/functions/v1/${name}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function backoff(attempt: number) {
  const base = 400 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 200);
  await new Promise((r) => setTimeout(r, base + jitter));
}

class RetryableError extends Error {}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function loggedFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  console.info(`[ai:${label}] POST`, url);
  try {
    const res = await fetch(url, init);
    console.info(`[ai:${label}] response`, res.status, res.statusText);
    return res;
  } catch (e) {
    console.error(`[ai:${label}] fetch failed`, e);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Network error calling ${label} (${msg}). Check the Supabase URL is reachable and the Edge Function is deployed.`,
    );
  }
}

export class SupabaseAIProvider implements AIProvider {
  readonly name = "Verbatim AI Cloud";

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const headers = await getAuthHeaders();

    const form = new FormData();
    form.append("audio", input.audio, "audio.webm");
    if (input.language && input.language !== "auto") {
      form.append("language", input.language);
    }
    if (input.vocabularyHints && input.vocabularyHints.length > 0) {
      form.append("vocabularyHints", input.vocabularyHints.join(", "));
    }

    const url = functionUrl("transcribe");

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await withTimeout(
          loggedFetch(url, { method: "POST", headers, body: form }, "transcribe"),
          TRANSCRIBE_TIMEOUT_MS,
        );
        if (!res.ok) {
          const body = await safeReadText(res);
          if (res.status >= 500 || res.status === 429) {
            throw new RetryableError(`${res.status}: ${body || res.statusText}`);
          }
          throw new Error(`${res.status}: ${body || res.statusText}`);
        }
        return (await res.json()) as TranscribeResult;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof RetryableError)) throw e;
        if (attempt < MAX_RETRIES - 1) await backoff(attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async *cleanup(input: CleanupInput): AsyncIterable<string> {
    const headers = {
      ...(await getAuthHeaders()),
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const res = await withTimeout(
      loggedFetch(
        functionUrl("cleanup"),
        { method: "POST", headers, body: JSON.stringify(input) },
        "cleanup",
      ),
      CLEANUP_TIMEOUT_MS,
    );

    if (!res.ok || !res.body) {
      const errBody = await safeReadText(res);
      throw new Error(`${res.status}: ${errBody || res.statusText}`);
    }

    yield* parseSSEStream(res.body);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const start = performance.now();
      const headers = await getAuthHeaders();
      const res = await withTimeout(
        fetch(functionUrl("cleanup"), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            rawText: "ping",
            systemPrompt: "Echo the input.",
            modeName: "ping",
            temperature: 0,
          }),
        }),
        10_000,
      );
      const latencyMs = Math.round(performance.now() - start);
      if (res.ok) return { ok: true, message: "Connected", latencyMs };
      const body = await safeReadText(res);
      return { ok: false, message: `${res.status}: ${body.slice(0, 600) || res.statusText}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

let cached: SupabaseAIProvider | null = null;
export function getActiveProvider(): AIProvider | null {
  if (!cached) cached = new SupabaseAIProvider();
  return cached;
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // ignore keep-alives / malformed lines
      }
    }
  }
}
