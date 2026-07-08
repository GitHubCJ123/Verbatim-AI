// supabase/functions/cleanup/index.ts
// Streaming chat-completion proxy. Body is forwarded to Azure with
// stream=true and the SSE stream is piped straight back to the client.
import {
  CORS_HEADERS,
  clean,
  envInt,
  genericCrash,
  json,
  requireEdgeAccess,
} from "../_shared/security.ts";

const MAX_BODY_BYTES = envInt("CLEANUP_MAX_BODY_BYTES", 256 * 1024);
const MAX_RAW_TEXT_CHARS = envInt("CLEANUP_MAX_RAW_TEXT_CHARS", 24_000);
const MAX_SYSTEM_PROMPT_CHARS = envInt("CLEANUP_MAX_SYSTEM_PROMPT_CHARS", 6000);
const MAX_MODE_NAME_CHARS = envInt("CLEANUP_MAX_MODE_NAME_CHARS", 120);
const MAX_MODE_DESCRIPTION_CHARS = envInt("CLEANUP_MAX_MODE_DESCRIPTION_CHARS", 2000);
const MAX_VOCAB_ITEMS = envInt("CLEANUP_MAX_VOCAB_ITEMS", 200);
const MAX_VOCAB_ITEM_CHARS = envInt("CLEANUP_MAX_VOCAB_ITEM_CHARS", 120);
const MAX_TARGET_LANGUAGE_CHARS = envInt("CLEANUP_MAX_TARGET_LANGUAGE_CHARS", 80);
const MAX_OUTPUT_TOKENS = envInt("CLEANUP_MAX_OUTPUT_TOKENS", 4096);
const RATE_LIMIT_WINDOW_SECONDS = envInt("CLEANUP_RATE_LIMIT_WINDOW_SECONDS", 60 * 60);
const RATE_LIMIT_PER_USER = envInt("CLEANUP_RATE_LIMIT_PER_USER", 120);
const RATE_LIMIT_PER_IP = envInt("CLEANUP_RATE_LIMIT_PER_IP", 240);

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
    return genericCrash("cleanup", e);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const access = await requireEdgeAccess(req, {
    functionName: "cleanup",
    maxBodyBytes: MAX_BODY_BYTES,
    rateLimit: {
      userLimit: RATE_LIMIT_PER_USER,
      ipLimit: RATE_LIMIT_PER_IP,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    },
  });
  if (!access.ok) return access.response;

  const AZURE_ENDPOINT = clean(Deno.env.get("AZURE_ENDPOINT"));
  const AZURE_API_KEY = clean(Deno.env.get("AZURE_API_KEY"));
  const AZURE_CLEANUP_DEPLOYMENT = clean(Deno.env.get("AZURE_CLEANUP_DEPLOYMENT"));
  const API_VERSION = clean(Deno.env.get("AZURE_API_VERSION")) ?? "2024-06-01";

  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_CLEANUP_DEPLOYMENT) {
    console.error("cleanup missing Azure configuration", {
      endpoint: Boolean(AZURE_ENDPOINT),
      key: Boolean(AZURE_API_KEY),
      deployment: Boolean(AZURE_CLEANUP_DEPLOYMENT),
    });
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
  const validationError = validateCleanupRequest(payload);
  if (validationError) return validationError;

  const { system, user } = buildPrompt(payload);
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: clampTemperature(payload.temperature),
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

function validateCleanupRequest(input: CleanupRequest): Response | null {
  if (typeof input.rawText !== "string" || input.rawText.length > MAX_RAW_TEXT_CHARS) {
    return json({ error: "rawText is too large." }, 413);
  }
  if (typeof input.systemPrompt !== "string" || input.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    return json({ error: "systemPrompt is too large." }, 413);
  }
  if (typeof input.modeName !== "string" || input.modeName.length > MAX_MODE_NAME_CHARS) {
    return json({ error: "modeName is invalid." }, 400);
  }
  if (
    input.modeDescription !== undefined &&
    (typeof input.modeDescription !== "string" ||
      input.modeDescription.length > MAX_MODE_DESCRIPTION_CHARS)
  ) {
    return json({ error: "modeDescription is too large." }, 413);
  }
  if (
    input.targetLanguage !== undefined &&
    (typeof input.targetLanguage !== "string" ||
      input.targetLanguage.length > MAX_TARGET_LANGUAGE_CHARS)
  ) {
    return json({ error: "targetLanguage is invalid." }, 400);
  }
  if (input.vocabulary !== undefined) {
    if (!Array.isArray(input.vocabulary) || input.vocabulary.length > MAX_VOCAB_ITEMS) {
      return json({ error: "vocabulary is too large." }, 413);
    }
    for (const term of input.vocabulary) {
      if (typeof term !== "string" || term.length > MAX_VOCAB_ITEM_CHARS) {
        return json({ error: "vocabulary contains an invalid item." }, 400);
      }
    }
  }
  return null;
}

function clampTemperature(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.3;
  return Math.min(2, Math.max(0, value));
}
