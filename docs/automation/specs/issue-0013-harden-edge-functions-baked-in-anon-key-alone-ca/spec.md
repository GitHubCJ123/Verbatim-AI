# Spec

Proposed content for `docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md`:

```markdown
# Spec: Issue 0013 - Harden Edge Functions Against Anon-Key-Only Quota Abuse

## Assumptions

1. Local mode must remain accountless from the user's perspective: no signup UI, prompts, email, or password.
2. Supabase anonymous auth is available for this project and can be enabled in the Supabase dashboard.
3. `transcribe` and `cleanup` are currently deployed with `--no-verify-jwt` only to support local-mode users.
4. The shipped frontend necessarily contains `VITE_SUPABASE_ANON_KEY`, so the anon key must not be treated as sufficient authorization for paid Azure-backed work.
5. This spec covers implementation and verification; production redeploy/dashboard changes are operator-controlled.

## Objective

Prevent direct consumption of Azure AI Foundry quota by callers who only extracted the baked-in Supabase anon key, while preserving the existing no-account local-mode UX.

Success means:

- Edge Functions require a real Supabase JWT, preferably an anonymous-user JWT for local mode.
- Requests authenticated only with the baked-in anon key are rejected.
- Local-mode users continue using transcription and cleanup without account creation.
- Server-side request-size and audio-duration limits prevent oversized or abusive payloads.
- Cloud-mode authenticated users keep existing behavior.

## Problem

The desktop app ships with `VITE_SUPABASE_ANON_KEY` embedded in the frontend bundle. Today, the `transcribe` and `cleanup` Supabase Edge Functions are deployed with JWT verification disabled so local-mode users can call them without a Supabase account. That makes the anon key effectively enough to invoke Azure-backed functions directly.

There is also no explicit server-side cap for request body size or audio duration, so abuse can happen through both request volume and request size.

## Current Repo Facts

- Verbatim AI is a Tauri 2 desktop app with a React/TypeScript frontend and Rust backend.
- The frontend lives under `src/`; Tauri backend code lives under `src-tauri/`.
- App mode is controlled by `src/lib/appMode.ts` using localStorage key `sw.app.mode`, with values `"local"` and `"cloud"`.
- AI provider routing is centralized in `src/lib/ai/index.ts`.
- Existing providers include `SupabaseAIProvider`, `LocalWhisperProvider`, `ParakeetProvider`, and `OllamaProvider`.
- Supabase Edge Functions include:
  - `supabase/functions/transcribe`
  - `supabase/functions/cleanup`
- Local mode currently avoids Supabase account auth, while cloud mode uses Supabase auth.
- Stores cache data into localStorage so the overlay window can operate synchronously where needed.
- Known repo commands:
  - Install: `pnpm install`
  - Frontend build: `pnpm build`
  - Lint: `pnpm lint`
  - Format: `pnpm format`
  - Desktop dev: `pnpm tauri dev`
  - Vite-only dev: `pnpm dev`

## Architecture

### Target Auth Model

Use Supabase anonymous authentication for local mode.

Local-mode flow:

1. On first need for a Supabase-backed Edge Function, ensure an anonymous Supabase session exists.
2. If no session exists, call Supabase anonymous sign-in.
3. Persist/reuse the resulting Supabase session through the existing Supabase client/session storage.
4. Send Edge Function requests with:
   - `Authorization: Bearer <anonymous-user-access-token>`
   - `apikey: <VITE_SUPABASE_ANON_KEY>`
5. Edge Functions are redeployed with JWT verification enabled.
6. Supabase validates the JWT before function code runs.

Cloud-mode flow:

1. Continue using the signed-in user's Supabase session.
2. Send Edge Function requests with the authenticated user's access token.
3. Existing cloud-mode behavior remains unchanged.

Rejected flow:

1. A caller sends only the anon key as bearer token or omits a real user JWT.
2. Supabase JWT verification rejects the request before Azure resources are used.

### Frontend Components

Primary touched frontend surfaces:

- `src/lib/appMode.ts`
  - Add or expose helper semantics for local-mode anonymous auth if appropriate.
- `src/lib/ai/index.ts`
  - Update `getAuthHeaders` so local mode obtains an anonymous session token instead of using the anon key as the bearer token.
  - Preserve cloud-mode behavior using the current authenticated session token.
  - Avoid prompt/UI changes.

Recommended helper shape:

```ts
async function getEdgeFunctionAuthHeaders(): Promise<Record<string, string>> {
  const session = await ensureFunctionSession();

  if (!session?.access_token) {
    throw new Error("Unable to authenticate Edge Function request");
  }

  return {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${session.access_token}`,
  };
}
```

Key convention:

- The anon key remains the Supabase project API key.
- The bearer token must be a user JWT, never the anon key.

### Edge Function Components

Primary touched serverless surfaces:

- `supabase/functions/transcribe`
- `supabase/functions/cleanup`

Required behavior:

- Assume Supabase JWT verification is enabled at deployment.
- Do not accept anon-key-only authorization in function code.
- Validate request body size before expensive processing.
- Validate audio duration server-side for transcription.
- Return explicit client errors for invalid input:
  - `413 Payload Too Large` for oversized request bodies.
  - `400 Bad Request` for unsupported or malformed payloads.
  - `422 Unprocessable Entity` for valid payload shape with unacceptable audio duration, if that matches existing API style.
- Avoid broad catch blocks that convert security failures into successful responses.

### Deployment Architecture

Future deployment commands must omit `--no-verify-jwt`:

```bash
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Supabase dashboard configuration:

- Enable anonymous sign-ins for the project.
- Confirm JWT verification is enabled for both Edge Functions after deployment.

## Security Requirements

### Authentication

- `Authorization` must contain a Supabase user access token.
- Local mode must use an anonymous-user JWT.
- Cloud mode must use the authenticated user's JWT.
- The anon key may only be used as the Supabase API key, not as the bearer credential.
- Requests authenticated only with the baked-in anon key must not reach Azure-backed work.

### Abuse Controls

Implement server-side hard caps:

- Maximum request body size for both `transcribe` and `cleanup`.
- Maximum accepted audio duration for `transcribe`.
- Maximum cleanup input text length for `cleanup`, if not already enforced.
- Reject invalid payloads before calling Azure AI Foundry.

Exact limits should be centralized as named constants in each function or a shared function helper if one already exists. Suggested initial caps:

- Transcription body size: 25 MB.
- Audio duration: 10 minutes.
- Cleanup text input: 50,000 characters.

If existing product limits differ, use the stricter existing product limit.

### Rate Limiting

Preferred implementation for this issue is anonymous Supabase JWTs plus JWT verification. Per-user rate limiting may be implemented in a follow-up unless required for launch.

If adding rate limiting now, prefer per-user counters keyed by Supabase `sub`, not anon key. Per-IP rate limiting is acceptable only as a stopgap because desktop users may share NATs or VPNs.

### Secrets

- Do not add Azure keys, Supabase service-role keys, or other secrets to frontend code.
- Do not log full auth headers, JWTs, request bodies, audio blobs, transcripts, or cleanup prompts.
- Error responses must not disclose provider secrets, internal credentials, or upstream Azure details.

## Testing Strategy

### Frontend Tests

Add or update tests around auth-header selection:

1. Local mode with no existing session:
   - Creates or retrieves an anonymous session.
   - Uses anonymous access token as bearer token.
   - Keeps anon key only in `apikey`.
2. Local mode with existing anonymous session:
   - Reuses the session.
3. Cloud mode:
   - Uses the authenticated user's access token.
4. Missing/failed session:
   - Surfaces an explicit error and does not silently fall back to anon-key bearer auth.

### Edge Function Tests

Add tests or local verification coverage for:

1. Missing `Authorization` header is rejected when JWT verification is enabled.
2. `Authorization: Bearer <anon-key>` is rejected.
3. Valid anonymous-user JWT is accepted.
4. Oversized transcription request is rejected before provider invocation.
5. Excessive audio duration is rejected before provider invocation.
6. Oversized cleanup input is rejected before provider invocation.
7. Valid requests still succeed.

Where direct Supabase JWT verification cannot be exercised in unit tests, cover function-local validation separately and document deployment verification for JWT enforcement.

### Manual Verification

After dashboard config and redeploy:

```bash
pnpm lint
pnpm build
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Manual auth checks:

- Call `transcribe` with only anon key as bearer token and confirm rejection.
- Call `cleanup` with only anon key as bearer token and confirm rejection.
- Run local mode in the app and confirm transcription/cleanup still works without account prompts.
- Run cloud mode with a signed-in account and confirm transcription/cleanup still works.
- Submit oversized payloads and confirm server-side rejection.

## Screenshots / Evidence

No product UI change is expected, so screenshots are not required for acceptance.

Attach evidence instead:

- Network or log evidence that local mode sends an anonymous-user JWT as bearer token.
- Function response evidence that anon-key-only requests are rejected.
- Function response evidence that oversized bodies/audio are rejected.
- Optional screenshot of Supabase dashboard anonymous sign-in setting enabled, with sensitive project values redacted.

All screenshots or logs must redact:

- JWTs
- Supabase anon key
- Supabase URLs if considered sensitive
- Azure endpoint names/keys
- User identifiers
- Audio/transcript content

## Boundaries

### Always Do

- Preserve local-mode no-account UX.
- Keep bearer auth as a real Supabase user JWT.
- Reject oversized input server-side before Azure calls.
- Use explicit errors for auth/input failures.
- Keep secrets out of source, logs, screenshots, and test fixtures.
- Update directly related docs or deployment notes if deployment flags change.

### Ask First

- Adding a new paid dependency for rate limiting.
- Adding database tables for counters or quotas.
- Changing pricing, plan limits, or user-visible quotas.
- Changing CI configuration.
- Changing Supabase auth provider settings beyond anonymous sign-ins.

### Never Do

- Reintroduce `--no-verify-jwt` for these functions as the default deployment path.
- Use `VITE_SUPABASE_ANON_KEY` as an `Authorization` bearer token.
- Commit Supabase service-role keys, Azure keys, JWTs, or captured user payloads.
- Log raw audio, transcripts, cleanup prompts, or full request bodies.
- Silently fall back from failed anonymous auth to anon-key-only function calls.

## Implementation Plan

1. Add frontend anonymous-session support for local-mode Edge Function calls.
   - Ensure local mode can obtain a Supabase anonymous session without UI.
   - Ensure cloud mode still uses the authenticated user's session.
   - Ensure failures do not fall back to anon-key bearer auth.

2. Update Edge Function request headers.
   - Replace anon-key bearer usage with session access token bearer usage.
   - Keep anon key as `apikey`.

3. Harden `transcribe`.
   - Add request body size validation.
   - Add server-side audio duration validation.
   - Reject invalid or oversized payloads before provider invocation.

4. Harden `cleanup`.
   - Add request body size validation.
   - Add text length validation.
   - Reject invalid or oversized payloads before provider invocation.

5. Update tests.
   - Cover local anonymous auth header generation.
   - Cover cloud auth header generation.
   - Cover no anon-key bearer fallback.
   - Cover Edge Function payload caps.

6. Update deployment documentation.
   - Remove `--no-verify-jwt` from deploy instructions for `transcribe` and `cleanup`.
   - Note Supabase dashboard requirement: anonymous sign-ins enabled.

7. Verify manually in local and cloud modes.
   - Confirm local mode has no visible UX change.
   - Confirm anon-key-only requests are rejected.
   - Confirm oversized payloads are rejected.

## Task Breakdown

- [ ] Task: Enable anonymous local-mode function auth
  - Acceptance: Local mode obtains/reuses an anonymous Supabase session without UI.
  - Verify: Unit test or mocked integration proves local mode bearer token is an anonymous session token.
  - Files: `src/lib/appMode.ts`, `src/lib/ai/index.ts`, related tests.

- [ ] Task: Stop using anon key as bearer credential
  - Acceptance: `Authorization` is always `Bearer <session.access_token>` for Edge Function calls.
  - Verify: Tests assert anon key appears only in `apikey`, never as bearer token.
  - Files: `src/lib/ai/index.ts`, related tests.

- [ ] Task: Add transcription input caps
  - Acceptance: Oversized request bodies and excessive audio durations are rejected before Azure calls.
  - Verify: Edge Function tests or local function invocation.
  - Files: `supabase/functions/transcribe/**`.

- [ ] Task: Add cleanup input caps
  - Acceptance: Oversized request bodies and excessive text inputs are rejected before Azure calls.
  - Verify: Edge Function tests or local function invocation.
  - Files: `supabase/functions/cleanup/**`.

- [ ] Task: Update deployment docs
  - Acceptance: Deploy instructions no longer use `--no-verify-jwt` for these functions and mention anonymous sign-ins.
  - Verify: Documentation review.
  - Files: relevant docs or this spec-linked deployment notes.

## Acceptance Criteria

- Requests with only the baked-in anon key are rejected before Azure work starts.
- Local-mode users can still transcribe and clean up text without signup, prompts, or account creation.
- Cloud-mode users retain existing behavior.
- Edge Functions are deployable with JWT verification enabled.
- `transcribe` rejects oversized bodies.
- `transcribe` rejects absurd or excessive audio durations.
- `cleanup` rejects oversized bodies and excessive text input.
- Tests cover auth-header behavior and input caps.
- Deployment notes clearly state that `--no-verify-jwt` must not be used for these functions.
- No secrets, JWTs, raw audio, transcripts, or cleanup prompts are logged or committed.

## Open Questions

1. What exact product limits should be used for audio duration, transcription upload size, and cleanup text length?
2. Should per-user rate limiting be implemented in this issue or tracked as a follow-up after anonymous JWT enforcement?
3. Should quota counters distinguish anonymous local users from cloud authenticated users?
4. Where should deployment instructions live if there is no existing Supabase deployment doc?
```
