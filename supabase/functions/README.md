# SuperWisper Edge Functions

Two functions proxy Azure AI Foundry from the client so the API key never leaves the server.

## Required secrets

```bash
supabase secrets set AZURE_ENDPOINT="https://<your-resource>.openai.azure.com"
supabase secrets set AZURE_API_KEY="<your-azure-key>"
supabase secrets set AZURE_TRANSCRIBE_DEPLOYMENT="whisper"
supabase secrets set AZURE_CLEANUP_DEPLOYMENT="gpt-4o-mini"
# Optional: override the Azure REST API version
supabase secrets set AZURE_API_VERSION="2024-06-01"
```

## Deploy

```bash
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Both functions are JWT-protected by default — the client must send the user's bearer token, which Supabase verifies before invoking the handler.

## Endpoints

- `POST /functions/v1/transcribe` — multipart `audio` + optional `language`, `vocabularyHints`. Returns `{ text, languageDetected, durationMs, segments? }`.
- `POST /functions/v1/cleanup` — JSON `{ rawText, systemPrompt, modeName, modeDescription?, vocabulary?, targetLanguage?, temperature? }`. Returns an SSE stream of OpenAI-style chat-completion chunks.
