// supabase/functions/cleanup/index.ts
// Streaming chat-completion proxy. Body is forwarded to Azure with
// stream=true and the SSE stream is piped straight back to the client.

function clean(v: string | undefined): string | undefined {
  return v?.replace(/[\x00-\x1F\x7F]/g, "").trim();
}

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
  try {
    return await handle(req);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
    console.error("cleanup crash:", msg);
    return json({ error: `cleanup crashed: ${msg.slice(0, 800)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const AZURE_ENDPOINT = clean(Deno.env.get("AZURE_ENDPOINT"));
  const AZURE_API_KEY = clean(Deno.env.get("AZURE_API_KEY"));
  const AZURE_CLEANUP_DEPLOYMENT = clean(Deno.env.get("AZURE_CLEANUP_DEPLOYMENT"));
  const API_VERSION = clean(Deno.env.get("AZURE_API_VERSION")) ?? "2024-06-01";

  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_CLEANUP_DEPLOYMENT) {
    return json({
      error: `Server is missing Azure configuration. endpoint:${!!AZURE_ENDPOINT} key:${!!AZURE_API_KEY} deployment:${!!AZURE_CLEANUP_DEPLOYMENT}`,
    }, 500);
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
}

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
    `You are Verbatim AI's polishing layer for the "${input.modeName}" mode.`,
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
    "- Convert spoken punctuation/formatting commands into the actual characters:",
    '  "open paren" / "open parenthesis" / "open parentheses" -> (',
    '  "close paren" / "close parenthesis" / "close parentheses" -> )',
    '  "open bracket" -> [   "close bracket" -> ]',
    '  "open brace" / "open curly" -> {   "close brace" / "close curly" -> }',
    '  "quote" / "open quote" -> "   "close quote" / "unquote" -> "',
    '  "comma" -> ,   "period" / "full stop" -> .   "question mark" -> ?   "exclamation mark" -> !',
    '  "colon" -> :   "semicolon" -> ;   "dash" / "hyphen" -> -   "em dash" -> —',
    '  "slash" -> /   "backslash" -> \\\\   "ampersand" -> &   "at sign" -> @',
    '  "new line" / "newline" -> line break.   "new paragraph" -> blank line.',
    "  Only do the substitution when the speaker clearly meant the symbol, not when they used the word naturally.",
    `- ${input.systemPrompt}${translationLine}`,
    "",
    "Return ONLY the polished text. No commentary, no quotes.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user: `RAW TRANSCRIPT:\n${input.rawText}` };
}
