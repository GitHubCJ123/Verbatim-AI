<!-- verbatim-ai:artifact:v1 issue=13 phase=spec id=issue-0013-issue-0013-67ea41ba-4688-431f-b8bd-a620f03da490-SPEC-003 display=SPEC-003 run=issue-0013-67ea41ba-4688-431f-b8bd-a620f03da490 -->
# SPEC-003: Architect spec

- Issue: #13
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0013-issue-0013-67ea41ba-4688-431f-b8bd-a620f03da490-SPEC-003
- Agent: architect
- Run: issue-0013-67ea41ba-4688-431f-b8bd-a620f03da490
- Created: 2026-07-24T17:50:30.532Z

## Summary

Spec

## Body

# Spec

Proposed spec content for `docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md`:

```markdown
# Spec: Harden Edge Functions Against Anon-Key Quota Abuse

## Assumptions

1. Local mode should remain accountless from the user’s perspective, but may use Supabase anonymous auth internally.
2. Supabase anonymous sign-ins can be enabled in the project dashboard before deployment.
3. The preferred solution is to require a real JWT for Edge Function access, not rely on the baked-in anon key as bearer auth.
4. Server-side request caps are required even after JWT enforcement.

## Objective

Prevent extracted `VITE_SUPABASE_ANON_KEY` values from being sufficient to consume Azure AI Foundry quota through the `transcribe` and `cleanup` Supabase Edge Functions.

Success means:

- Requests authenticated only with the Supabase anon key cannot use quota.
- Local-mode users still do not see sign-up, login, or account prompts.
- Edge Functions reject oversized or abusive requests before calling Azure-backed providers.
- Rate limiting is tied to a stable caller identity where possible.

## Current Repo Facts

- Verbatim AI is a Tauri 2 desktop app with a React/TypeScript frontend and Rust backend.
- App mode is stored through `src/lib/appMode.ts` as either `local` or `cloud`.
- AI provider selection flows through `src/lib/ai/index.ts`.
- `SupabaseAIProvider` calls Supabase Edge Functions for transcription and cleanup.
- Supabase Edge Functions currently include:
  - `supabase/functions/transcribe`
  - `supabase/functions/cleanup`
- Existing deployment docs/commands use `--no-verify-jwt`, allowing calls that present only the anon key.
- `VITE_SUPABASE_ANON_KEY` is necessarily shipped in the client bundle and should be treated as public.
- Local mode currently has no user account, but can still call deployed Edge Functions.

## Architecture

### Preferred Design

Use Supabase anonymous authentication for local-mode users.

1. On local-mode startup or before the first Supabase AI call, ensure an anonymous Supabase session exists.
2. Use the anonymous session access token as the `Authorization: Bearer <jwt>` value for Edge Function calls.
3. Redeploy `transcribe` and `cleanup` with JWT verification enabled.
4. In each Edge Function, derive rate-limit identity from the verified JWT subject.
5. Reject invalid, missing, or anon-key-only bearer credentials.
6. Add server-side caps for request body size and audio duration.

### Authentication Flow

Cloud mode:

```text
User session JWT -> SupabaseAIProvider -> Edge Function -> Azure provider
```

Local mode:

```text
Anonymous Supabase session JWT -> SupabaseAIProvider -> Edge Function -> Azure provider
```

Rejected:

```text
Anon key only -> Edge Function -> 401/403, no Azure call
```

### Request Limits

`transcribe` should enforce:

- Maximum request body size.
- Maximum audio duration, either from metadata if trusted enough or by inspecting uploaded audio server-side.
- Supported audio MIME/type allowlist where practical.

`cleanup` should enforce:

- Maximum request body size.
- Maximum text length.
- Reasonable schema validation before provider calls.

### Rate Limiting

Implement per-user rate limiting keyed by JWT subject.

Preferred storage options, in order:

1. Existing Supabase/Postgres-backed counter if available.
2. Upstash or equivalent external limiter if already approved.
3. Minimal DB-backed limiter as a stopgap.

Rate limits should be conservative enough to protect Azure quota but generous enough for normal local-mode use.

## Tech Stack

- Frontend: React, TypeScript, Vite
- Desktop shell: Tauri 2
- State: Zustand/localStorage stores
- Backend functions: Supabase Edge Functions
- Auth: Supabase Auth, including anonymous sign-ins
- AI quota risk surface: Azure AI Foundry via Supabase Edge Functions

## Commands

Use existing project commands only:

```bash
pnpm install
pnpm lint
pnpm build
pnpm tauri dev
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Deployment must not use `--no-verify-jwt` for these hardened functions.

## Project Structure

```text
src/lib/appMode.ts
  App mode helpers and local/cloud mode state.

src/lib/ai/index.ts
  Supabase AI provider, active provider selection, and auth header construction.

supabase/functions/transcribe/
  Edge Function for audio transcription; add JWT-required behavior, request validation, duration/body caps, and rate limiting.

supabase/functions/cleanup/
  Edge Function for cleanup/rewriting; add JWT-required behavior, request validation, body/text caps, and rate limiting.

docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md
  This implementation spec.
```

## Code Style

Prefer explicit auth/session handling over fallback behavior that silently weakens security.

Example shape:

```ts
const session = await ensureSupabaseSessionForMode(appMode)

if (!session?.access_token) {
  throw new Error('Supabase session is required to call AI functions')
}

return {
  apikey: supabaseAnonKey,
  Authorization: `Bearer ${session.access_token}`,
}
```

Do not treat the anon key as a bearer credential. The anon key may remain in the `apikey` header if required by Supabase client semantics, but quota-bearing function authorization must depend on a verified JWT.

## Security Requirements

- Do not commit secrets.
- Do not add provider keys or service-role keys to frontend code.
- Do not log full request bodies, audio payloads, transcripts, cleanup text, JWTs, auth headers, or API keys.
- Reject unauthenticated function calls before parsing expensive payloads or calling Azure.
- Validate request schema before provider calls.
- Enforce body-size limits server-side.
- Enforce audio-duration or text-length limits server-side.
- Rate-limit by verified user identity.
- Preserve cloud-mode authenticated-user behavior.
- Preserve local-mode accountless UX through anonymous sessions.

## Testing Strategy

### Unit / Integration Tests

Add or update tests to cover:

- `getAuthHeaders` or equivalent auth construction:
  - Cloud mode uses the authenticated user session token.
  - Local mode creates/reuses an anonymous session token.
  - Missing session fails loudly instead of falling back to anon-key bearer auth.

- `transcribe` Edge Function:
  - Rejects missing bearer token.
  - Rejects bearer token equal to the anon key.
  - Rejects oversized body.
  - Rejects excessive audio duration.
  - Does not call the provider when validation/auth fails.

- `cleanup` Edge Function:
  - Rejects missing bearer token.
  - Rejects bearer token equal to the anon key.
  - Rejects oversized body or excessive text length.
  - Does not call the provider when validation/auth fails.

### Manual Verification

- In local mode, first transcription still works without visible sign-up or login.
- In cloud mode, existing authenticated transcription and cleanup still work.
- Direct curl-style requests using only the anon key are rejected or strictly rate-limited.
- Oversized audio/text requests fail with clear 4xx responses and do not consume Azure quota.

## Screenshots / Evidence

No product UI screenshot is required because this is a backend/auth hardening change with no intended UX change.

Attach evidence in the implementation PR instead:

- Supabase dashboard screenshot or note confirming anonymous sign-ins are enabled.
- Function deployment logs showing `transcribe` and `cleanup` deployed without `--no-verify-jwt`.
- Test output showing auth rejection and size-cap coverage.
- Optional network trace showing local mode uses a JWT bearer token, with tokens redacted.

## Boundaries

- Always:
  - Preserve local-mode no-account UX.
  - Keep anon key treated as public.
  - Fail closed on missing/invalid auth.
  - Add server-side validation before Azure calls.
  - Redact tokens and payloads in logs/tests/docs.

- Ask first:
  - Adding a paid external rate-limit dependency.
  - Changing Supabase database schema.
  - Changing global auth settings beyond enabling anonymous sign-ins.
  - Introducing new telemetry or analytics.

- Never:
  - Put service-role keys in frontend code.
  - Use anon key as bearer authorization for quota-bearing functions.
  - Log secrets, JWTs, raw audio, transcripts, or cleanup text.
  - Disable JWT verification for these functions after hardening.

## Acceptance Criteria

- Requests with only the baked-in anon key are rejected before reaching Azure-backed provider code, or are subject to a strict emergency rate limit if a phased rollout requires temporary compatibility.
- Local-mode users can continue using transcription and cleanup without creating an account or seeing auth prompts.
- Local mode obtains and reuses a Supabase anonymous session internally.
- Cloud-mode authenticated users continue to work.
- `transcribe` enforces server-side request body and audio-duration caps.
- `cleanup` enforces server-side request body and text-length caps.
- Rate limiting is applied per verified JWT subject.
- Tests cover anon-key-only rejection, local anonymous-session auth, cloud-session auth, oversized request rejection, and provider-call bypass on invalid requests.
- Deployment documentation or release notes no longer instruct deploying these functions with `--no-verify-jwt`.

## Open Questions

- Which rate-limit backend should be used if no existing Supabase/Postgres limiter exists?
- What exact limits should be chosen for audio duration, audio body size, cleanup text length, and requests per time window?
- Should anonymous-session creation happen at app boot, local-mode selection, or lazily before the first AI request?
```

