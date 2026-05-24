// supabase/functions/cleanup/index.ts
// Streaming chat-completion proxy. Body is forwarded to Azure with
// stream=true and the SSE stream is piped straight back to the client.

const AZURE_ENDPOINT = Deno.env.get("AZURE_ENDPOINT");
const AZURE_API_KEY = Deno.env.get("AZURE_API_KEY");
const AZURE_CLEANUP_DEPLOYMENT = Deno.env.get("AZURE_CLEANUP_DEPLOYMENT");
const API_VERSION = Deno.env.get("AZURE_API_VERSION") ?? "2024-06-01";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

interface CleanupRequest {
  rawText: string;
  systemPrompt: string;
  modeName: string;
  modeDescription?: string;
  vocabulary?: string[];
  targetLanguage?: string;
  temperature?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_CLEANUP_DEPLOYMENT) {
    return json({ error: "Server is missing Azure configuration." }, 500);
  }

  let payload: CleanupRequest;
  try {
    payload = (await req.json()) as CleanupRequest;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  if (!payload.rawText || !payload.systemPrompt || !payload.modeName) {
    return json({ error: "Missing rawText, systemPrompt, or modeName." }, 400);
  }

  const { system, user } = buildPrompt(payload);
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: payload.temperature ?? 0.3,
    stream: true,
  };

  const url = `${trim(AZURE_ENDPOINT)}/openai/deployments/${encodeURIComponent(
    AZURE_CLEANUP_DEPLOYMENT,
  )}/chat/completions?api-version=${API_VERSION}`;

  const azureRes = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": AZURE_API_KEY,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!azureRes.ok || !azureRes.body) {
    const text = await azureRes.text().catch(() => "");
    return json(
      { error: `Azure ${azureRes.status}: ${text.slice(0, 400)}` },
      azureRes.status >= 500 ? 502 : azureRes.status,
    );
  }

  // Pipe the SSE response straight back.
  return new Response(azureRes.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...CORS_HEADERS,
    },
  });
});

function trim(s: string): string {
  return s.replace(/\/+$/, "");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function buildPrompt(input: CleanupRequest): { system: string; user: string } {
  const vocab =
    input.vocabulary && input.vocabulary.length > 0
      ? input.vocabulary.map((t) => `- ${t}`).join("\n")
      : "(none provided)";
  const translationLine = input.targetLanguage
    ? `\n- Translate the result into ${input.targetLanguage} naturally.`
    : "";

  const system = [
    `You are SuperWisper's polishing layer for the "${input.modeName}" mode.`,
    "",
    input.modeDescription ? `Goal: ${input.modeDescription}` : "",
    "",
    "Specialized vocabulary the user often uses (preserve exact spelling):",
    vocab,
    "",
    "Rules:",
    "- Preserve the speaker's intent and voice.",
    '- Remove disfluencies ("um", "uh", false starts, repeated words).',
    "- Fix grammar and punctuation.",
    `- ${input.systemPrompt}${translationLine}`,
    "",
    "Return ONLY the polished text. No commentary, no quotes.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user: `RAW TRANSCRIPT:\n${input.rawText}` };
}
