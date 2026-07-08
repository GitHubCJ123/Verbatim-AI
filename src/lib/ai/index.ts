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
import { supabase, supabaseAnonKey, supabaseUrl, isSupabaseConfigured } from "../supabase";
import { CLOUD_FEATURES_ENABLED } from "../features";
import { isLocalMode } from "../appMode";
import {
  LocalWhisperProvider,
  getAiProviderKind,
  getLocalWhisperTier,
  effectiveTranscribeKind,
  type WhisperTier,
} from "./localWhisper";
import {
  OllamaProvider,
  getCleanupProviderKind,
  getOllamaHost,
  getOllamaModel,
  effectiveCleanupKind,
} from "./ollama";
import { LlamaCppProvider, getLlamaCppModel } from "./llamaCpp";
import {
  ParakeetProvider,
  getParakeetLanguage,
  getParakeetVariant,
  type ParakeetVariant,
} from "./parakeet";
import { edgeAppSecretHeaders, serializeDurationMs } from "./edgeAuth";
import type { Mode } from "../../types/mode";

export * from "./localWhisper";
export * from "./ollama";
export * from "./llamaCpp";
export * from "./parakeet";

const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — covers long recordings; whisper auto-chunks anyway.
const CLEANUP_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — long transcripts can stream for a while.
const MAX_RETRIES = 3;

async function getAuthHeaders(): Promise<Record<string, string>> {
  // Cloud AI proxies through Supabase Edge Functions — a fully-local
  // setup (no .env.local) can reach this only if the user explicitly
  // picks the cloud provider. Fail with a clear message instead of a
  // raw network error against an empty URL.
  if (!isSupabaseConfigured) {
    throw new Error(
      "Cloud AI needs Supabase configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local). " +
        "Switch to Local Whisper or Parakeet in Settings → AI model to run fully offline instead.",
    );
  }
  const anon = supabaseAnonKey();
  const { data } = await supabase.auth.getSession();
  let token = data.session?.access_token;

  if (isLocalMode()) {
    token = token ?? (await signInAnonymouslyForCloudAi()) ?? anon;
  } else if (!token) {
    throw new Error("Not signed in.");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    apikey: anon,
    ...edgeAppSecretHeaders(),
  };
  return headers;
}

async function signInAnonymouslyForCloudAi(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) {
      console.warn(
        "Cloud AI anonymous sign-in unavailable; falling back to the anon key.",
        error.message,
      );
      return null;
    }
    return data.session?.access_token ?? null;
  } catch (e) {
    console.warn("Cloud AI anonymous sign-in threw; falling back to the anon key.", e);
    return null;
  }
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
    const durationMs = serializeDurationMs(input.durationMs);
    if (durationMs !== undefined) form.append("durationMs", durationMs);
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
          if (res.status >= 500) {
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

let cloudCache: SupabaseAIProvider | null = null;
const localWhisperByTier = new Map<WhisperTier, LocalWhisperProvider>();
const ollamaByKey = new Map<string, OllamaProvider>();
const llamaCppByModel = new Map<string, LlamaCppProvider>();
const parakeetByKey = new Map<string, ParakeetProvider>();

function getCloud(): SupabaseAIProvider {
  if (!cloudCache) cloudCache = new SupabaseAIProvider();
  return cloudCache;
}

/**
 * Legacy cleanup fallback wired into the transcribe-only providers
 * (Local Whisper / Parakeet). The active pipeline (getActiveProvider)
 * resolves cleanup independently, so this is never invoked there; while
 * cloud is disabled we still avoid any latent network path by falling
 * back to the resolved local cleanup provider instead of the cloud one.
 */
function cloudCleanupFallback(): AIProvider {
  return CLOUD_FEATURES_ENABLED ? getCloud() : cleanupProvider();
}

function transcribeProvider(mode?: Mode | null): AIProvider {
  const kind = effectiveTranscribeKind(mode?.transcribeProviderOverride ?? getAiProviderKind());
  if (kind === "cloud") return getCloud();
  if (kind === "local-parakeet") {
    const variant: ParakeetVariant = getParakeetVariant();
    const language = getParakeetLanguage();
    const key = `${variant}|${language}`;
    let p = parakeetByKey.get(key);
    if (!p) {
      p = new ParakeetProvider({
        variant,
        language,
        cleanupFallback: cloudCleanupFallback(),
      });
      parakeetByKey.set(key, p);
    }
    return p;
  }
  const tier = (mode?.whisperTierOverride ?? getLocalWhisperTier()) as WhisperTier;
  let p = localWhisperByTier.get(tier);
  if (!p) {
    p = new LocalWhisperProvider({ tier, cleanupFallback: cloudCleanupFallback() });
    localWhisperByTier.set(tier, p);
  }
  return p;
}

function cleanupProvider(mode?: Mode | null): AIProvider {
  const kind = effectiveCleanupKind(mode?.cleanupProviderOverride ?? getCleanupProviderKind());
  if (kind === "cloud") return getCloud();
  if (kind === "local-llama-cpp") {
    const model = getLlamaCppModel();
    let p = llamaCppByModel.get(model);
    if (!p) {
      p = new LlamaCppProvider({ model });
      llamaCppByModel.set(model, p);
    }
    return p;
  }
  const host = getOllamaHost();
  const model = mode?.ollamaModelOverride ?? getOllamaModel();
  const key = `${host}|${model}`;
  let p = ollamaByKey.get(key);
  if (!p) {
    p = new OllamaProvider({ host, model });
    ollamaByKey.set(key, p);
  }
  return p;
}

export async function testTranscriptionProvider(mode?: Mode | null): Promise<ProviderHealth> {
  return transcribeProvider(mode).health();
}

export async function testCleanupProvider(mode?: Mode | null): Promise<ProviderHealth> {
  return cleanupProvider(mode).health();
}

/**
 * Returns a composite provider: transcribe-half and cleanup-half are
 * picked independently from user settings, with optional per-Mode
 * overrides. If the Mode has any override set, that always wins over
 * the global setting.
 */
export function getActiveProvider(mode?: Mode | null): AIProvider | null {
  const t = transcribeProvider(mode);
  const c = cleanupProvider(mode);
  return {
    name: `${t.name} → ${c.name}`,
    transcribe: (input) => t.transcribe(input),
    cleanup: (input) => c.cleanup(input),
    async health() {
      const [ht, hc] = await Promise.all([t.health(), c.health()]);
      return {
        ok: ht.ok && hc.ok,
        message:
          ht.ok && hc.ok
            ? "Both providers ready"
            : `Transcribe: ${ht.message} · Cleanup: ${hc.message}`,
      };
    },
  };
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
