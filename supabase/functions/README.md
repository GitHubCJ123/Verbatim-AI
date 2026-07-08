# Verbatim AI Edge Functions

Two functions proxy Azure AI Foundry from the client so the API key never leaves the server.

## Required secrets

```bash
supabase secrets set AZURE_ENDPOINT="https://<your-resource>.openai.azure.com"
supabase secrets set AZURE_API_KEY="<your-azure-key>"
supabase secrets set AZURE_TRANSCRIBE_DEPLOYMENT="whisper"
supabase secrets set AZURE_CLEANUP_DEPLOYMENT="gpt-4o-mini"
# Optional: override the Azure REST API version
supabase secrets set AZURE_API_VERSION="2024-06-01"

# Optional soft app-attestation gate. If set, clients must send the same
# value in x-verbatim-app-secret (VITE_VERBATIM_EDGE_APP_SECRET at build
# time). This is defense-in-depth only because desktop bundles can be
# inspected; auth + rate limits remain the quota boundary.
supabase secrets set VERBATIM_EDGE_APP_SECRET="<random-rollout-secret>"

# Optional production hardening knobs.
supabase secrets set VERBATIM_RATE_LIMIT_STRICT="1"
supabase secrets set VERBATIM_RATE_LIMIT_IP_HASH_SALT="<random-hash-salt>"
```

Anonymous sign-ins must be enabled in Supabase Auth. Local app mode uses an
anonymous Supabase session token so Edge Functions can reject raw anon-key
bearer calls while still avoiding sign-up prompts.

## Deploy

```bash
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Both functions should be deployed with JWT verification enabled (the default).
The handlers also verify the bearer token with Supabase Auth so a request that
only uses the public anon key is rejected even during a safe rollout where
platform JWT verification is temporarily disabled.

## Quota and size limits

`0014_edge_rate_limits.sql` adds a service-role-only rate-limit table/RPC used
by both functions. Defaults can be overridden with Supabase secrets:

- `TRANSCRIBE_RATE_LIMIT_PER_USER` / `TRANSCRIBE_RATE_LIMIT_PER_IP`
- `CLEANUP_RATE_LIMIT_PER_USER` / `CLEANUP_RATE_LIMIT_PER_IP`
- `*_RATE_LIMIT_WINDOW_SECONDS`
- `TRANSCRIBE_MAX_BODY_BYTES`, `TRANSCRIBE_MAX_AUDIO_BYTES`, `TRANSCRIBE_MAX_AUDIO_SECONDS`
- `CLEANUP_MAX_BODY_BYTES`, `CLEANUP_MAX_RAW_TEXT_CHARS`, `CLEANUP_MAX_OUTPUT_TOKENS`

## Endpoints

- `POST /functions/v1/transcribe` — multipart `audio` + optional `language`, `vocabularyHints`. Returns `{ text, languageDetected, durationMs, segments? }`.
- `POST /functions/v1/cleanup` — JSON `{ rawText, systemPrompt, modeName, modeDescription?, vocabulary?, targetLanguage?, temperature? }`. Returns an SSE stream of OpenAI-style chat-completion chunks.
