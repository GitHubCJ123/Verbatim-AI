<!-- verbatim-ai:artifact:v1 issue=13 phase=spec id=issue-0013-issue-0013-4cf7bdcc-f9e5-4fb8-ba65-c29422e4c369-SPEC-004 display=SPEC-004 run=issue-0013-4cf7bdcc-f9e5-4fb8-ba65-c29422e4c369 -->
# SPEC-004: Architect spec

- Issue: #13
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0013-issue-0013-4cf7bdcc-f9e5-4fb8-ba65-c29422e4c369-SPEC-004
- Agent: architect
- Run: issue-0013-4cf7bdcc-f9e5-4fb8-ba65-c29422e4c369
- Created: 2026-07-24T21:52:44.018Z

## Summary

Spec

## Body

# Spec

Proposed content for `docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md`:

```markdown
# Spec: Harden Edge Functions Against Baked-In Anon-Key Quota Abuse

## Assumptions

1. Verbatim AI intentionally supports local mode without a user-created account.
2. Supabase anonymous auth is acceptable for local-mode identity because it creates a real JWT without signup UX.
3. The shipped frontend must continue to include `VITE_SUPABASE_ANON_KEY`; the goal is to make that key insufficient by itself to consume Azure quota.
4. The `transcribe` and `cleanup` Edge Functions are currently callable with anon-key-only auth because they are deployed with JWT verification disabled.
5. No product UI screenshots are required because the desired local-mode UX is unchanged.

## Objective

Prevent extracted Supabase anon keys from being enough to call the `transcribe` and `cleanup` Edge Functions and burn Azure AI Foundry quota.

Success means:

- Local-mode users still use transcription and cleanup without signup, prompts, or account-management UX.
- Direct requests using only the baked-in anon key are rejected, or at minimum constrained by strict server-side rate limits.
- Edge Functions enforce server-side request-size and duration limits before expensive provider calls.
- Abuse controls apply consistently to both transcription and cleanup paths.

## Current Repo Facts

- Verbatim AI is a Tauri 2 desktop app with a React/TypeScript frontend and Rust backend.
- Frontend source lives under `src/`.
- Supabase Edge Functions live under `supabase/functions/`.
- App mode is controlled by `src/lib/appMode.ts`; local mode avoids Supabase user-account UX.
- AI provider selection and Supabase function calls are centralized in `src/lib/ai/index.ts`.
- Existing provider architecture includes:
  - `SupabaseAIProvider` for cloud-backed transcription/cleanup.
  - Local Whisper and Parakeet providers for local transcription.
  - Ollama for local cleanup.
- The main affected functions are:
  - `supabase/functions/transcribe`
  - `supabase/functions/cleanup`
- Deployment should stop using `--no-verify-jwt` for these functions once local mode obtains anonymous JWTs.

## Architecture

### Target auth flow

1. On app startup or before the first Supabase-backed local-mode AI request, the frontend checks whether local mode has a valid Supabase auth session.
2. If no session exists, the frontend silently calls Supabase anonymous sign-in.
3. The resulting access token is cached by Supabase auth persistence.
4. `getAuthHeaders` uses:
   - `apikey: VITE_SUPABASE_ANON_KEY`
   - `Authorization: Bearer <anonymous-or-real-session-access-token>`
5. Edge Functions require a valid JWT.
6. The functions derive the caller identity from the verified JWT and apply per-user abuse controls.

### Cloud-mode behavior

Cloud mode should continue using the authenticated user session token. No cloud-mode auth regression is acceptable.

### Local-mode behavior

Local mode still means “no account the user created,” not “no Supabase identity exists.” Anonymous auth is an implementation detail and must not introduce onboarding prompts.

### Edge Function request handling

Both `transcribe` and `cleanup` should follow this order:

1. Reject unauthenticated requests before reading or processing expensive payloads.
2. Enforce request body size limits.
3. Validate content type and request shape.
4. Enforce audio duration limits for transcription.
5. Apply rate limiting using the verified user identity, and optionally IP as a secondary key.
6. Call Azure AI Foundry only after all local validations pass.

## Security Design

### Primary control: JWT-required Edge Functions

The anon key is still public client configuration and must not be treated as a secret. The security boundary is a verified Supabase JWT.

Required behavior:

- Missing `Authorization` header: reject.
- `Authorization: Bearer <anon-key>`: reject.
- Invalid/expired JWT: reject.
- Valid anonymous JWT: allow within limits.
- Valid authenticated user JWT: allow within limits.

### Rate limiting

Implement per-caller rate limits keyed by Supabase user ID from the verified JWT.

Recommended tiers:

| Function | Limit basis | Suggested initial cap |
|---|---:|---:|
| `transcribe` | requests per user | Conservative per-minute and per-day caps |
| `cleanup` | requests per user | Conservative per-minute and per-day caps |
| `transcribe` | audio duration per user | Daily accumulated duration cap |
| `cleanup` | text size per user | Daily accumulated character/token proxy cap |

If a durable external limiter is added, prefer a simple server-side store such as Supabase Postgres counters or Upstash. Do not rely only on in-memory counters because Edge Function instances are ephemeral.

### Request caps

`transcribe` must reject:

- Bodies above the configured byte limit.
- Unsupported content types.
- Audio files whose decoded or declared duration exceeds the configured maximum.
- Empty or malformed audio payloads.

`cleanup` must reject:

- Bodies above the configured byte limit.
- Text above the configured character limit.
- Missing or malformed mode/config fields.
- Payloads that would clearly exceed expected cleanup cost.

### Error handling

Errors should be explicit and non-leaky:

- `401` for missing/invalid JWT.
- `413` for oversized body.
- `415` for unsupported media/content type.
- `422` for malformed valid-size payload.
- `429` for rate-limit exceeded.
- `500` only for unexpected server failures.

Do not include secrets, Azure details, raw JWTs, full request bodies, or internal stack traces in responses.

## Implementation Plan

### 1. Enable anonymous local-mode sessions

Files likely touched:

- `src/lib/appMode.ts`
- `src/lib/ai/index.ts`
- Existing Supabase client/auth helper files, if present.

Requirements:

- Add or reuse a helper that ensures a Supabase session exists before Supabase-backed local-mode calls.
- In local mode, silently call anonymous sign-in when no session exists.
- In cloud mode, require the existing authenticated session behavior.
- Update `getAuthHeaders` so the bearer token is a Supabase access token, not the anon key.
- Preserve the anon key only as the `apikey` header.

### 2. Require JWTs for Edge Functions

Files likely touched:

- `supabase/functions/transcribe`
- `supabase/functions/cleanup`
- Supabase function config/deployment docs if present.

Requirements:

- Remove reliance on `--no-verify-jwt`.
- Configure/deploy both functions with JWT verification enabled.
- Validate that anon-key-only requests no longer reach provider calls.

Deployment commands for implementer reference:

```bash
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Do not use:

```bash
supabase functions deploy transcribe --no-verify-jwt
supabase functions deploy cleanup --no-verify-jwt
```

### 3. Add server-side request caps

Files likely touched:

- `supabase/functions/transcribe`
- `supabase/functions/cleanup`
- Shared function utilities if the repo already has them.

Requirements:

- Add constants for max body size, max audio duration, max cleanup text length, and supported content types.
- Ensure limits are enforced before Azure calls.
- Keep limits configurable via environment variables only if the existing function style supports it; otherwise use conservative constants.

### 4. Add rate limiting

Files likely touched:

- `supabase/functions/transcribe`
- `supabase/functions/cleanup`
- Shared function utilities/migrations if using database-backed counters.

Requirements:

- Rate limit by verified Supabase user ID.
- Use IP only as an additional signal, not the primary identity.
- Return `429` with a clear retry-safe message.
- Avoid logging PII or raw request contents.

### 5. Documentation and deployment notes

Files likely touched:

- This spec.
- Existing deployment docs, if any.
- Supabase setup docs, if any.

Requirements:

- Document that anonymous sign-ins must be enabled in the Supabase dashboard.
- Document that Edge Functions must be deployed with JWT verification enabled.
- Document relevant environment variables and operational limits.

## Testing Strategy

### Frontend tests

Add or update tests around auth header construction and local-mode session behavior.

Cases:

- Local mode with no session triggers anonymous sign-in before Supabase AI request.
- Local mode with existing anonymous session reuses the access token.
- Cloud mode uses the authenticated session token.
- `Authorization` header never uses `VITE_SUPABASE_ANON_KEY` as bearer.
- `apikey` header still uses the anon key.

Suggested commands:

```bash
pnpm lint
pnpm build
```

If the repo has targeted test scripts, add targeted invocations here during implementation.

### Edge Function tests

Add function-level tests or documented curl/manual checks for:

- Missing auth returns `401`.
- Anon-key-only bearer returns `401`.
- Invalid JWT returns `401`.
- Valid anonymous JWT reaches validation.
- Oversized transcription body returns `413`.
- Overlong audio returns `422` or `413`, depending on implementation.
- Oversized cleanup body/text returns `413` or `422`.
- Rate-limit exhaustion returns `429`.
- Valid local-mode anonymous request succeeds within limits.

### Manual verification

Use a real Supabase project with anonymous sign-ins enabled.

Manual checks:

1. Launch local mode with no existing session.
2. Trigger transcription/cleanup.
3. Confirm no signup prompt appears.
4. Confirm function request includes a bearer JWT distinct from the anon key.
5. Confirm direct anon-key-only calls are rejected.
6. Confirm oversized requests are rejected before Azure provider invocation.

## Screenshots

No product screenshots are required because there should be no visible UX change.

If documenting verification, capture only non-sensitive evidence:

- Network inspector or logs showing `Authorization: Bearer <redacted JWT>`.
- Function response status for anon-key-only rejection.
- Function response status for oversized request rejection.

All screenshots must redact:

- JWTs
- Supabase anon keys
- Project URLs if considered sensitive
- User IDs
- Emails
- Raw transcription audio/text

## Boundaries

### Always do

- Treat the Supabase anon key as public.
- Require a verified JWT before expensive function work.
- Keep local-mode UX prompt-free.
- Enforce request-size and duration limits server-side.
- Return explicit HTTP status codes.
- Redact secrets and PII in logs, tests, screenshots, and docs.

### Ask first

- Adding a new paid third-party rate-limiting service.
- Changing Supabase database schema for durable counters.
- Introducing new user-visible account or onboarding UI.
- Changing Azure provider configuration or quota settings.
- Changing CI or deployment automation.

### Never do

- Commit Supabase service-role keys, Azure keys, JWTs, or real anon tokens.
- Log raw request bodies, raw audio, JWTs, or provider credentials.
- Rely on frontend-only limits for quota protection.
- Treat local mode as unauthenticated when calling cloud Edge Functions.
- Re-enable `--no-verify-jwt` for `transcribe` or `cleanup` after this change.

## Acceptance Criteria

- `transcribe` rejects requests that provide only the baked-in anon key.
- `cleanup` rejects requests that provide only the baked-in anon key.
- Local-mode users can still transcribe and clean up text without signup, prompts, or visible UX changes.
- Local-mode Supabase-backed requests use a valid anonymous Supabase JWT.
- Cloud-mode requests continue using the signed-in user JWT.
- Oversized transcription requests are rejected server-side.
- Absurdly long audio requests are rejected server-side.
- Oversized cleanup requests are rejected server-side.
- Rate limiting exists per verified caller, or a documented strict stopgap is implemented.
- Azure provider calls happen only after auth, size, shape, duration, and rate-limit checks pass.
- Tests or manual verification cover anon-key-only rejection, valid anonymous local-mode success, oversized payload rejection, and rate-limit behavior.

## Open Questions

1. Which durable rate-limit backend should be used: Supabase Postgres counters, Upstash, or another existing project service?
2. What exact initial limits should be enforced for body size, audio duration, request rate, and daily usage?
3. Does the current Supabase project already have anonymous sign-ins enabled, or is a dashboard change required?
4. Should anonymous local-mode sessions be migrated or linked if a user later signs into cloud mode?
5. Are there existing Edge Function test helpers that should be reused instead of adding new test infrastructure?
```

