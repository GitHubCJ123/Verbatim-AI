// supabase/functions/transcribe/index.ts
// Proxies multipart audio uploads to Azure Whisper.
// Auth: Supabase enforces a valid JWT before the function runs.

const AZURE_ENDPOINT = Deno.env.get("AZURE_ENDPOINT");
const AZURE_API_KEY = Deno.env.get("AZURE_API_KEY");
const AZURE_TRANSCRIBE_DEPLOYMENT = Deno.env.get("AZURE_TRANSCRIBE_DEPLOYMENT");
const API_VERSION = Deno.env.get("AZURE_API_VERSION") ?? "2024-06-01";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_TRANSCRIBE_DEPLOYMENT) {
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

  const language = (form.get("language") as string | null) ?? undefined;
  const vocabularyHints = form.get("vocabularyHints");

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
  return json({
    text: data.text ?? "",
    languageDetected: data.language ?? "unknown",
    durationMs: Math.round((data.duration ?? 0) * 1000),
    segments: data.segments,
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

async function fetchWithRetry(url: string, init: RequestInit, max = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < max; i++) {
    const res = await fetch(url, init);
    if (res.ok || (res.status < 500 && res.status !== 429)) return res;
    last = res;
    if (i < max - 1) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
    }
  }
  return last!;
}
