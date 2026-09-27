<!-- verbatim-ai:artifact:v1 issue=13 phase=spec id=issue-0013-issue-0013-5265d708-b1dc-444e-b289-c0f4d32a5621-SPEC-006 display=SPEC-006 run=issue-0013-5265d708-b1dc-444e-b289-c0f4d32a5621 -->
# SPEC-006: Architect spec

- Issue: #13
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0013-issue-0013-5265d708-b1dc-444e-b289-c0f4d32a5621-SPEC-006
- Agent: architect
- Run: issue-0013-5265d708-b1dc-444e-b289-c0f4d32a5621
- Created: 2026-07-25T06:02:35.563Z

## Summary

Spec

## Body

# Spec

● skill(doc-coauthoring)

```markdown
# Spec: Harden Edge Functions Against Anon-Key Quota Abuse

## Objective

Prevent extracted `VITE_SUPABASE_ANON_KEY` values from being sufficient to consume Azure AI Foundry quota through the `transcribe` and `cleanup` Supabase Edge Functions.

Local-mode users must keep the same UX: no account creation prompt, no sign-up screen, and no visible authentication step. Behind the scenes, local mode should obtain and persist a Supabase anonymous auth session, then call Edge Functions with that user JWT instead of using the baked-in anon key as the bearer token.

## Assumptions

1. Supabase anonymous sign-ins can be enabled for this project in the Supabase dashboard.
2. Local mode may create an anonymous Supabase Auth user without changing the product meaning of “local mode.”
3. Edge Functions can be redeployed with JWT verification enabled.
4. The anon key may still be sent as the `apikey` header when needed by Supabase infrastructure, but must no longer be accepted as the `Authorization: Bearer` credential for AI quota-consuming functions.
5. Server-side request caps should be enforced even if the client already validates audio size or duration.

## Current Repo Facts

- Verbatim AI is a Tauri 2 desktop app with a React/TypeScript frontend and Rust backend.
- App mode is controlled by `src/lib/appMode.ts`; `local` mode currently avoids Supabase account sign-in.
- AI provider selection is handled in `src/lib/ai/index.ts` through `getActiveProvider`.
- Supabase-backed AI calls go through Edge Functions:
  - `supabase/functions/transcribe`
  - `supabase/functions/cleanup`
- Local and cloud modes both rely on Supabase Edge Functions for cloud transcription/cleanup paths.
- The shipped frontend includes `VITE_SUPABASE_ANON_KEY`.
- The affected Edge Functions have been deployed with `--no-verify-jwt`, allowing calls that only possess the baked-in anon key.
- There is currently no documented server-side rate limit or strict request-size/audio-duration cap for these functions.

## Proposed Architecture

### Authentication Flow

Local mode should silently bootstrap a Supabase anonymous session:

1. On first use of a Supabase-backed AI provider in local mode, check for an existing Supabase auth session.
2. If no session exists, call Supabase anonymous sign-in.
3. Persist the anonymous session using Supabase Auth’s normal local persistence.
4. Use the anonymous session access token as `Authorization: Bearer <access_token>` for `transcribe` and `cleanup`.
5. Continue sending the Supabase anon key only where required as `apikey`, not as the bearer identity.

Cloud mode should continue using the signed-in user’s Supabase access token.

### Edge Function Authorization

Both Edge Functions should require a valid Supabase JWT:

- Redeploy `transcribe` and `cleanup` without `--no-verify-jwt`.
- Treat missing, malformed, expired, or anon-key-only bearer credentials as unauthorized.
- Derive rate-limit identity from the verified JWT subject.
- Avoid trusting client-provided user IDs.

### Rate Limiting

Implement server-side rate limits keyed by authenticated Supabase user ID.

Preferred implementation: Supabase/Postgres-backed counters or RPC, to avoid introducing a new third-party dependency unless necessary.

Suggested policy:

| Function | Limit Key | Initial Limit |
|---|---|---|
| `transcribe` | JWT `sub` | Conservative per-minute and per-day quota |
| `cleanup` | JWT `sub` | Conservative per-minute and per-day quota |

Exact limits should be configurable through Edge Function environment variables so production can tune without code changes.

### Request Caps

Both functions must enforce hard server-side caps before invoking Azure:

- Maximum request body size.
- Maximum accepted audio duration for transcription.
- Maximum text/input size for cleanup.
- Clear `413 Payload Too Large` or `400 Bad Request` responses for invalid payloads.
- No Azure call should occur after a cap failure.

For audio duration, prefer parsing metadata or validating decoded audio duration server-side. If duration cannot be reliably determined, reject the request rather than forwarding unbounded input to Azure.

## Security Requirements

- The baked-in anon key alone must not authorize quota-consuming AI calls.
- Anonymous local users must receive distinct JWT identities so abuse can be rate-limited per anonymous user.
- Edge Functions must not trust client-supplied identity, duration, size, or mode fields.
- Server-side validation must happen before Azure credentials are used.
- Error responses must not expose Azure keys, Supabase service-role keys, stack traces, internal configuration, or rate-limit storage details.
- Any service-role key used for rate-limit writes must remain server-only in Edge Function secrets.
- Rate-limit bypasses through function-specific paths, missing headers, oversized bodies, or malformed content types must be covered by tests.

## Implementation Surfaces

### Frontend

Files likely touched:

- `src/lib/appMode.ts`
- `src/lib/ai/index.ts`
- Related Supabase auth/client utilities if present.

Required behavior:

- Add a local-mode anonymous-session helper.
- Ensure `getAuthHeaders` or equivalent auth-header construction is async if needed.
- In local mode, use an anonymous Supabase session token as the bearer token.
- In cloud mode, use the authenticated user session token.
- Do not fall back to `Authorization: Bearer <anon key>` for these Edge Functions.

### Edge Functions

Files likely touched:

- `supabase/functions/transcribe/**`
- `supabase/functions/cleanup/**`
- Shared function utilities, if present or worth extracting.

Required behavior:

- Enforce JWT verification through deployment configuration.
- Validate request body size and content before processing.
- Validate audio duration for transcription.
- Validate text/input size for cleanup.
- Apply authenticated per-user rate limiting.
- Return consistent status codes:
  - `401` for missing/invalid JWT.
  - `429` for rate-limit exhaustion.
  - `413` for oversized payloads.
  - `400` for malformed or unsupported input.

### Supabase Configuration

Manual/project configuration required:

- Enable anonymous sign-ins in Supabase Auth settings.
- Redeploy `transcribe` and `cleanup` with JWT verification enabled.
- Add any Edge Function environment variables for caps/rate limits.

## Testing Strategy

### Unit Tests

Add or update tests for:

- Local-mode auth-header generation uses anonymous session access token.
- Cloud-mode auth-header generation uses signed-in user access token.
- No path returns the anon key as the bearer token for AI Edge Function calls.
- Request cap helpers reject oversized bodies.
- Cleanup input-size validation rejects absurdly large text.
- Rate-limit helper allows requests below limit and rejects above limit.

### Edge Function Tests

Cover:

- Request with only anon key bearer is rejected.
- Request with no `Authorization` header is rejected.
- Request with valid anonymous JWT is accepted when under limits.
- Oversized transcription body is rejected before Azure invocation.
- Excessive audio duration is rejected before Azure invocation.
- Oversized cleanup input is rejected before Azure invocation.
- Rate-limited user receives `429`.

### Manual Verification

Suggested commands for implementer/driver to run later:

```bash
pnpm lint
pnpm build
supabase functions serve transcribe
supabase functions serve cleanup
```

Manual checks:

1. Fresh local-mode install starts using transcription/cleanup without sign-up UI.
2. Existing cloud-mode signed-in user still works.
3. Direct request using only the anon key as bearer fails.
4. Direct request using anonymous session JWT succeeds under limits.
5. Oversized request fails without an Azure call.

## Screenshots

No user-facing UI change is expected.

Required screenshot evidence for PR/review:

1. Local-mode settings/app state showing no new sign-in prompt.
2. Successful local-mode transcription/cleanup flow after anonymous auth bootstrap.
3. Optional Supabase dashboard screenshot showing anonymous sign-ins enabled, with sensitive project identifiers redacted.

Screenshots must redact emails, project refs, access tokens, API keys, JWTs, and any user text/audio content.

## Acceptance Criteria

- `transcribe` and `cleanup` reject requests where the anon key is the only bearer credential.
- Local-mode users can still use cloud-backed transcription/cleanup without account creation, prompts, or UX changes.
- Local mode obtains and persists a Supabase anonymous auth session.
- Edge Functions require valid JWTs after redeploy.
- Rate limits are enforced per authenticated user identity.
- Oversized request bodies are rejected server-side.
- Absurd or unsupported audio durations are rejected server-side.
- Cleanup requests with excessive input size are rejected server-side.
- Rejections happen before any Azure AI Foundry request is made.
- Tests cover anon-key-only rejection, anonymous-JWT success, rate limiting, and request caps.

## Boundaries

- Always:
  - Keep secrets server-side only.
  - Validate input server-side before Azure calls.
  - Preserve local-mode no-account UX.
  - Use verified JWT claims for identity.
- Ask first:
  - Adding a new external rate-limit provider such as Upstash.
  - Changing Supabase schema or adding migrations solely for rate limiting.
  - Changing public pricing/quota policy.
- Never:
  - Commit Supabase service-role keys, Azure credentials, JWTs, or anon-session tokens.
  - Use the baked-in anon key as the bearer credential for quota-consuming Edge Functions.
  - Rely only on client-side request-size or duration validation.
  - Log raw audio, transcript text, cleanup text, tokens, or auth headers.

## Open Questions

1. What exact per-minute and per-day limits should apply to anonymous local users?
2. Should cloud authenticated users have different limits from anonymous local users?
3. Should rate-limit counters live in Supabase Postgres, or is an external low-latency store approved?
4. What maximum audio duration and request body size should production enforce?
5. What maximum cleanup input size should production enforce?
```

