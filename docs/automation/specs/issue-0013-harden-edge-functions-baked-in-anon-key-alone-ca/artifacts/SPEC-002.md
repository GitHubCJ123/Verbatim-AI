<!-- verbatim-ai:artifact:v1 issue=13 phase=spec id=issue-0013-issue-0013-c7b3a145-6332-4943-9904-9941784254fd-SPEC-002 display=SPEC-002 run=issue-0013-c7b3a145-6332-4943-9904-9941784254fd -->
# SPEC-002: Architect spec

- Issue: #13
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0013-issue-0013-c7b3a145-6332-4943-9904-9941784254fd-SPEC-002
- Agent: architect
- Run: issue-0013-c7b3a145-6332-4943-9904-9941784254fd
- Created: 2026-07-24T13:45:32.068Z

## Summary

Spec

## Body

# Spec

Proposed spec content for `docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md`:

```markdown
# Spec: Harden Edge Functions Against Baked-In Anon Key Abuse

## Objective

Prevent direct abuse of the shipped Supabase anon key from consuming Azure AI Foundry quota through the `transcribe` and `cleanup` Edge Functions, while preserving the current local-mode UX: users should not need to create an account, sign in, or respond to prompts.

The preferred design is to give local-mode users a Supabase anonymous auth session and require a real JWT for Edge Function calls. The anon key may still identify the Supabase project, but it must not be sufficient by itself to invoke quota-consuming AI functions.

## Problem

`VITE_SUPABASE_ANON_KEY` is embedded in the desktop app bundle. Because the `transcribe` and `cleanup` Edge Functions are currently deployed with JWT verification disabled, anyone who extracts the anon key can call those functions directly.

That creates three risks:

1. Azure AI Foundry quota can be consumed by unauthenticated third parties.
2. There is no reliable per-user identity for rate limiting in local mode.
3. Oversized request bodies or absurdly long audio payloads can increase cost and availability risk.

## Current Repo Facts

Based on the existing Verbatim AI architecture:

- The app is a Tauri 2 desktop app with React/TypeScript frontend and Rust backend.
- Local/cloud mode is controlled by `src/lib/appMode.ts`.
- AI provider selection and Supabase Edge Function calls are handled in `src/lib/ai/index.ts`.
- The app supports local mode without user-created Supabase accounts.
- Supabase auth is used in cloud mode.
- The `transcribe` and `cleanup` Edge Functions live under:
  - `supabase/functions/transcribe`
  - `supabase/functions/cleanup`
- Existing deployment notes indicate these functions have been deployed with `--no-verify-jwt`.
- The shipped frontend bundle includes `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- The quota-consuming operations are transcription and cleanup, backed by Azure AI Foundry through Supabase Edge Functions.

## Proposed Architecture

### Target Flow

1. On app startup, local mode ensures there is a Supabase anonymous auth session.
2. If no Supabase session exists in local mode, the app silently calls Supabase anonymous sign-in.
3. Calls to `transcribe` and `cleanup` use the session access token as the `Authorization: Bearer <jwt>` header.
4. Edge Functions are redeployed with JWT verification enabled.
5. Edge Functions reject requests that have only the anon key and no valid user JWT.
6. Edge Functions enforce request-size and workload limits server-side.
7. Optional but recommended: Edge Functions apply per-user rate limits keyed by authenticated Supabase user ID.

### Auth Behavior by App Mode

| Mode | User UX | Token used for Edge Functions |
|---|---|---|
| Cloud | Existing signed-in Supabase user | Existing user access token |
| Local | No account prompt, no sign-up UI | Anonymous Supabase user access token |

Local mode still means “no user-created account,” not “unauthenticated backend access.”

## Implementation Scope

### Frontend

Update:

- `src/lib/appMode.ts`
- `src/lib/ai/index.ts`
- Related auth/session helpers if present

Required behavior:

- Add or reuse a helper that returns a valid Supabase access token for Edge Function calls.
- In cloud mode, use the existing authenticated user session.
- In local mode, silently create or restore an anonymous Supabase session.
- Do not fall back to `Authorization: Bearer <anon key>` for quota-consuming Edge Functions.
- If anonymous sign-in fails, surface a real error through existing app error handling; do not silently continue with weaker auth.

Expected helper shape:

```ts
async function getAuthHeaders(): Promise<Record<string, string>> {
  const [REDACTED] getEdgeFunctionAccessToken();

  return {
    Authorization: `Bearer ${token}`,
  };
}
```

Avoid duplicating token logic across providers. Centralize the session lookup/sign-in behavior.

### Supabase Edge Functions

Update:

- `supabase/functions/transcribe`
- `supabase/functions/cleanup`

Required behavior:

- Assume JWT verification is enabled at deployment.
- Validate authenticated user identity from the verified request context or JWT.
- Reject missing/invalid user identity.
- Reject bodies above a defined maximum size.
- Reject audio above a defined maximum duration.
- Return clear HTTP status codes:
  - `401` for missing/invalid JWT
  - `413` for oversized request body
  - `422` for invalid or unsupported payload shape/duration
  - `429` if rate limiting is implemented
  - `500` only for unexpected server failures

### Deployment

Redeploy Edge Functions without `--no-verify-jwt`.

Required commands for implementer/operator:

```bash
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Supabase Dashboard requirement:

- Enable anonymous sign-ins for the project.

If anonymous sign-ins cannot be enabled in the target Supabase project, implement per-IP or per-user-equivalent rate limiting as a temporary fallback, but do not treat anon-key-only access as fully resolved.

## Security Requirements

### Must Have

- The anon key alone must not authorize quota-consuming function calls.
- Local-mode users must receive a real Supabase anonymous JWT.
- Edge Functions must enforce server-side request limits regardless of frontend validation.
- Edge Functions must not trust client-provided duration metadata alone.
- Error responses must not leak Azure credentials, Supabase secrets, stack traces, or internal provider details.
- No secrets may be added to frontend code, logs, docs, tests, or fixtures.

### Should Have

- Per-user rate limiting keyed by Supabase user ID.
- Separate limits for transcription and cleanup because their cost profiles differ.
- Logging that records coarse rejection reasons without storing audio, transcript text, cleanup text, JWTs, or full request bodies.

### Non-Goals

- Requiring local-mode users to create accounts.
- Replacing Supabase auth.
- Removing Azure AI Foundry integration.
- Building a full billing or quota dashboard.

## Request Limits

Define explicit constants in the Edge Functions or shared function utilities.

Recommended initial limits:

| Limit | Recommended value |
|---|---:|
| Transcribe request body size | 25 MB |
| Cleanup request body size | 256 KB |
| Max audio duration | 10 minutes |
| Max transcript/cleanup input characters | 100,000 chars |

Final values may be adjusted to match product expectations, but they must be documented in code and tested.

## Rate Limiting

Preferred key:

```text
supabase_user_id:function_name:window
```

Recommended baseline:

| Function | Limit |
|---|---:|
| transcribe | 60 requests / hour / user |
| cleanup | 300 requests / hour / user |

Acceptable implementations:

1. Supabase/Postgres-backed counter with expiry/windowing.
2. External rate-limit service such as Upstash.
3. Temporary per-IP limiter only if anonymous JWT rollout is blocked.

Rate limiting is desirable, but JWT enforcement and request caps are required.

## Testing Strategy

### Frontend Unit Tests

Cover:

- Local mode with no existing session creates anonymous session.
- Local mode with existing anonymous session reuses it.
- Cloud mode uses the existing signed-in user token.
- Missing session/sign-in failure does not fall back to anon-key bearer auth.
- `getAuthHeaders` returns `Authorization: Bearer <access_token>`, not the anon key.

Suggested command:

```bash
pnpm test
```

If the repo does not currently have a frontend test command, add focused tests using the existing test framework only.

### Edge Function Tests

Cover:

- Missing `Authorization` header is rejected.
- `Authorization: Bearer <anon key>` is rejected.
- Valid anonymous-user JWT is accepted.
- Valid cloud-user JWT is accepted.
- Oversized transcribe body is rejected.
- Oversized cleanup body is rejected.
- Audio exceeding maximum duration is rejected.
- Invalid payload shape returns `422`.
- Rate-limit exceeded returns `429`, if rate limiting is implemented.

### Manual Verification

Use curl or an equivalent HTTP client against a deployed or local Supabase function environment:

```bash
curl -i \
  -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" \
  "$SUPABASE_FUNCTION_URL/transcribe"
```

Expected result: request is rejected, preferably `401`.

Then verify local-mode app behavior:

1. Fresh install or cleared local app storage.
2. Select local mode.
3. Record audio.
4. Confirm transcription and cleanup still work without sign-up or prompt.
5. Confirm Edge Function logs show authenticated anonymous user identity.

### Build/Lint

Recommended validation commands:

```bash
pnpm lint
pnpm build
```

Supabase function validation should use the repo’s existing function test or local serve workflow if present.

## Screenshots / Visual QA

No new visible UI is expected.

Screenshots are only required if an auth failure or rate-limit error becomes visible in the app. If visible error handling changes, capture:

1. Local-mode successful recording after anonymous session creation.
2. Local-mode failure state if anonymous sign-in fails.
3. Any rate-limit or request-too-large user-facing message.

Expected visual result: no change for normal local-mode users.

## Acceptance Criteria

- Requests containing only the baked-in anon key cannot invoke `transcribe` or `cleanup`.
- Local-mode users can still transcribe and clean up text without creating an account or seeing an auth prompt.
- Cloud-mode users continue using their normal Supabase session.
- Edge Functions are deployed with JWT verification enabled.
- Server-side request body limits are enforced for both functions.
- Server-side audio duration limits are enforced for transcription.
- Cleanup input size is capped server-side.
- Auth failures, oversized requests, invalid payloads, and rate limits return appropriate non-`500` HTTP statuses.
- Tests cover local anonymous auth, cloud auth, anon-key-only rejection, and server-side request limits.
- No secrets or raw sensitive request contents are logged.

## Boundaries

### Always Do

- Preserve local-mode UX.
- Require real Supabase JWTs for quota-consuming Edge Functions.
- Validate request size and duration server-side.
- Keep auth-token selection centralized.
- Use existing repo conventions and existing test tooling.

### Ask First

- Adding a new third-party rate-limit dependency.
- Changing Supabase schema for durable rate limiting.
- Changing product limits that could materially affect normal users.
- Introducing new user-visible auth or quota UI.

### Never Do

- Do not rely on frontend-only limits.
- Do not use the anon key as a bearer token for `transcribe` or `cleanup`.
- Do not log JWTs, anon keys, audio, transcripts, cleanup text, or Azure secrets.
- Do not disable JWT verification to preserve local mode.
- Do not silently downgrade to unauthenticated function calls after auth failure.

## Open Questions

1. What exact request-size and duration limits should product enforce?
2. Should rate limiting be included in the first implementation or staged after anonymous JWT enforcement?
3. Should rate-limit storage use Supabase/Postgres or an external service?
4. What user-facing message should appear if anonymous sign-in fails in local mode?
5. Are there existing Supabase function test utilities in the repo that should be reused?
```

