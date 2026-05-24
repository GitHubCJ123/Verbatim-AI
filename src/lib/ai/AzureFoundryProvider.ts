/**
 * Azure AI Foundry / Azure OpenAI provider.
 *
 * Endpoint pattern:
 *   {endpoint}/openai/deployments/{deployment}/audio/transcriptions
 *   {endpoint}/openai/deployments/{deployment}/chat/completions
 *
 * Authentication uses the `api-key` header.
 */
import {
  type AIProvider,
  type CleanupInput,
  type ProviderHealth,
  type TranscribeInput,
  type TranscribeResult,
} from "./AIProvider";
import { buildCleanupPrompt } from "./promptBuilder";

const API_VERSION = "2024-06-01";

export interface AzureConfig {
  endpoint: string;
  /** Whisper-equivalent deployment for transcription. */
  transcribeDeployment: string;
  /** Chat deployment for the cleanup pass. */
  cleanupDeployment: string;
  apiKey: string;
}

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
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

export class AzureFoundryProvider implements AIProvider {
  readonly name = "Azure AI Foundry";

  constructor(private readonly config: AzureConfig) {
    if (!config.endpoint) throw new Error("Azure endpoint is required");
    if (!config.apiKey) throw new Error("Azure API key is required");
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const url = `${trimEndpoint(this.config.endpoint)}/openai/deployments/${encodeURIComponent(
      this.config.transcribeDeployment,
    )}/audio/transcriptions?api-version=${API_VERSION}`;

    const file = new File([input.audio], "audio.webm", { type: input.audio.type || "audio/webm" });
    const form = new FormData();
    form.append("file", file);
    form.append("response_format", "verbose_json");
    if (input.language && input.language !== "auto") {
      form.append("language", input.language);
    }
    if (input.vocabularyHints && input.vocabularyHints.length > 0) {
      // Whisper accepts a `prompt` field to bias recognition.
      form.append("prompt", input.vocabularyHints.join(", "));
    }

    const startedAt = performance.now();

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await withTimeout(
          fetch(url, {
            method: "POST",
            headers: { "api-key": this.config.apiKey },
            body: form,
          }),
          TRANSCRIBE_TIMEOUT_MS,
        );
        if (!res.ok) {
          const body = await safeReadText(res);
          if (res.status >= 500 || res.status === 429) {
            throw new RetryableError(`Azure ${res.status}: ${body || res.statusText}`);
          }
          throw new Error(`Azure ${res.status}: ${body || res.statusText}`);
        }
        const data = (await res.json()) as {
          text: string;
          language?: string;
          duration?: number;
          segments?: Array<{ start: number; end: number; text: string }>;
        };
        return {
          text: data.text ?? "",
          languageDetected: data.language ?? "unknown",
          durationMs: Math.round((data.duration ?? 0) * 1000) || performance.now() - startedAt,
          segments: data.segments,
        };
      } catch (e) {
        lastErr = e;
        if (!(e instanceof RetryableError)) throw e;
        if (attempt < MAX_RETRIES - 1) await backoff(attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async *cleanup(input: CleanupInput): AsyncIterable<string> {
    const url = `${trimEndpoint(this.config.endpoint)}/openai/deployments/${encodeURIComponent(
      this.config.cleanupDeployment,
    )}/chat/completions?api-version=${API_VERSION}`;

    const { system, user } = buildCleanupPrompt(input);
    const body = JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: input.temperature ?? 0.3,
      stream: true,
    });

    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body,
      }),
      CLEANUP_TIMEOUT_MS,
    );

    if (!res.ok || !res.body) {
      const errBody = await safeReadText(res);
      throw new Error(`Azure ${res.status}: ${errBody || res.statusText}`);
    }

    yield* parseSSEStream(res.body);
  }

  async health(): Promise<ProviderHealth> {
    const url = `${trimEndpoint(this.config.endpoint)}/openai/deployments/${encodeURIComponent(
      this.config.cleanupDeployment,
    )}/chat/completions?api-version=${API_VERSION}`;
    const start = performance.now();
    try {
      const res = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: {
            "api-key": this.config.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
          }),
        }),
        10_000,
      );
      const latencyMs = Math.round(performance.now() - start);
      if (res.ok) return { ok: true, message: "Connected", latencyMs };
      const body = await safeReadText(res);
      return { ok: false, message: `${res.status} ${res.statusText}: ${body.slice(0, 200)}` };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

class RetryableError extends Error {}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Parse a Server-Sent Events stream of OpenAI chat completion chunks
 * into the deltas' `content` fields.
 */
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
        // Ignore malformed lines (keep-alives, etc.)
      }
    }
  }
}
