/**
 * Shared OpenAI-compatible chat client.
 *
 * Several backends speak the same `/v1/chat/completions` streaming API:
 * our Supabase cloud proxy and `llama.cpp`'s `llama-server`. Rather than
 * duplicate the Server-Sent-Events parsing in each provider, we keep one
 * parser (`parseOpenAISSEStream`) plus a small request helper
 * (`streamOpenAIChatCompletion`) here and reuse them everywhere.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Parse an OpenAI-compatible SSE stream, yielding the `delta.content`
 * text pieces as they arrive. Stops on `data: [DONE]`. Keep-alives and
 * malformed lines are ignored.
 */
export async function* parseOpenAISSEStream(
  body: ReadableStream<Uint8Array>,
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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface OpenAIChatStreamParams {
  /** Base URL of the server, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** Optional model name. Omitted from the request when empty so a
   *  single-model `llama-server` just uses whatever it has loaded. */
  model?: string;
  /** Optional bearer token sent as `Authorization`. */
  apiKey?: string;
  system: string;
  user: string;
  temperature?: number;
  /** Inject a custom fetch (e.g. the Tauri HTTP plugin) to dodge the
   *  webview's http://localhost mixed-content block in production. */
  fetchImpl?: FetchLike;
  /** Human-readable backend name used in error messages. */
  providerLabel?: string;
  signal?: AbortSignal;
}

/**
 * POST a streaming chat completion to an OpenAI-compatible
 * `/v1/chat/completions` endpoint and yield the streamed text.
 */
export async function* streamOpenAIChatCompletion(
  params: OpenAIChatStreamParams,
): AsyncIterable<string> {
  const {
    baseUrl,
    model,
    apiKey,
    system,
    user,
    temperature,
    fetchImpl,
    providerLabel = "the server",
    signal,
  } = params;

  const doFetch: FetchLike = fetchImpl ?? fetch;
  const url = `${stripTrailingSlash(baseUrl)}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body: Record<string, unknown> = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
    temperature: temperature ?? 0.3,
  };
  // Only send `model` when set — llama-server serves the loaded model
  // regardless, and omitting it avoids 400s on strict single-model setups.
  if (model) body.model = model;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't reach ${providerLabel} at ${baseUrl}. Is it running? (${msg})`);
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`${providerLabel} returned ${res.status}: ${text.slice(0, 300)}`);
  }

  yield* parseOpenAISSEStream(res.body);
}
