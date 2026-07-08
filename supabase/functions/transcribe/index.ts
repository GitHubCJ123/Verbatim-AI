// supabase/functions/transcribe/index.ts
// Proxies multipart audio uploads to Azure Whisper.
// Auth: the handler requires a real Supabase user JWT, even if platform
// JWT verification is temporarily disabled during rollout.
import {
  CORS_HEADERS,
  clean,
  envInt,
  genericCrash,
  json,
  requireEdgeAccess,
} from "../_shared/security.ts";

const MAX_BODY_BYTES = envInt("TRANSCRIBE_MAX_BODY_BYTES", 26 * 1024 * 1024);
const MAX_AUDIO_BYTES = envInt("TRANSCRIBE_MAX_AUDIO_BYTES", 25 * 1024 * 1024);
const MAX_AUDIO_SECONDS = envInt("TRANSCRIBE_MAX_AUDIO_SECONDS", 5 * 60);
const MAX_VOCAB_HINTS_CHARS = envInt("TRANSCRIBE_MAX_VOCAB_HINTS_CHARS", 4000);
const RATE_LIMIT_WINDOW_SECONDS = envInt("TRANSCRIBE_RATE_LIMIT_WINDOW_SECONDS", 60 * 60);
const RATE_LIMIT_PER_USER = envInt("TRANSCRIBE_RATE_LIMIT_PER_USER", 60);
const RATE_LIMIT_PER_IP = envInt("TRANSCRIBE_RATE_LIMIT_PER_IP", 120);

const ALLOWED_AUDIO_TYPES = new Set([
  "",
  "application/octet-stream",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
]);

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return genericCrash("transcribe", e);
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
    functionName: "transcribe",
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
  const AZURE_TRANSCRIBE_DEPLOYMENT = clean(Deno.env.get("AZURE_TRANSCRIBE_DEPLOYMENT"));
  const API_VERSION = clean(Deno.env.get("AZURE_API_VERSION")) ?? "2024-06-01";

  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_TRANSCRIBE_DEPLOYMENT) {
    console.error("transcribe missing Azure configuration", {
      endpoint: Boolean(AZURE_ENDPOINT),
      key: Boolean(AZURE_API_KEY),
      deployment: Boolean(AZURE_TRANSCRIBE_DEPLOYMENT),
    });
    return json({ error: "Server is missing Azure configuration." }, 500);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Body must be multipart/form-data with 'audio'." }, 400);
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) && !(audio instanceof Blob)) {
    return json({ error: "Missing 'audio' file." }, 400);
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return json({ error: "Audio file is too large." }, 413);
  }
  if (!ALLOWED_AUDIO_TYPES.has(audio.type)) {
    return json({ error: "Unsupported audio content type." }, 415);
  }

  const durationMs = numericFormValue(form.get("durationMs"));
  if (durationMs !== null && durationMs > MAX_AUDIO_SECONDS * 1000) {
    return json({ error: "Audio duration is too long." }, 413);
  }

  const language = normalizedLanguage(form.get("language"));
  if (language === null) return json({ error: "Invalid language." }, 400);
  const vocabularyHints = form.get("vocabularyHints");
  if (typeof vocabularyHints === "string" && vocabularyHints.length > MAX_VOCAB_HINTS_CHARS) {
    return json({ error: "Vocabulary hints are too large." }, 413);
  }

  const upstream = new FormData();
  upstream.append("file", audio, "audio.webm");
  upstream.append("response_format", "verbose_json");
  if (language && language !== "auto") upstream.append("language", language);
  if (typeof vocabularyHints === "string" && vocabularyHints) {
    upstream.append("prompt", vocabularyHints);
  }

  const url = `${trim(AZURE_ENDPOINT)}/openai/deployments/${encodeURIComponent(
    AZURE_TRANSCRIBE_DEPLOYMENT,
  )}/audio/transcriptions?api-version=${API_VERSION}`;

  const azureRes = await fetchWithRetry(url, {
    method: "POST",
    headers: { "api-key": AZURE_API_KEY },
    body: upstream,
  });

  if (!azureRes.ok) {
    const text = await azureRes.text().catch(() => "");
    return json(
      { error: `Azure ${azureRes.status}: ${text.slice(0, 400)}` },
      azureRes.status >= 500 ? 502 : azureRes.status,
    );
  }

  const data = (await azureRes.json()) as {
    text?: string;
    language?: string;
    duration?: number;
    segments?: unknown;
  };
  if ((data.duration ?? 0) > MAX_AUDIO_SECONDS) {
    return json({ error: "Audio duration is too long." }, 413);
  }
  return json({
    text: data.text ?? "",
    languageDetected: data.language ?? "unknown",
    durationMs: Math.round((data.duration ?? 0) * 1000),
    segments: data.segments,
  });
}

function trim(s: string): string {
  return s.replace(/\/+$/, "");
}

async function fetchWithRetry(url: string, init: RequestInit, max = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < max; i++) {
    const res = await fetch(url, init);
    if (res.ok || res.status < 500) return res;
    last = res;
    if (i < max - 1) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
    }
  }
  return last!;
}

function normalizedLanguage(value: FormDataEntryValue | null): string | undefined | null {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const language = value.trim();
  if (language === "auto") return language;
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/.test(language) ? language : null;
}

function numericFormValue(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
