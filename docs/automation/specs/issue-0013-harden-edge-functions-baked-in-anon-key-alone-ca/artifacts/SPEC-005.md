<!-- verbatim-ai:artifact:v1 issue=13 phase=spec id=issue-0013-issue-0013-6bae8d27-58eb-43de-b942-ef48db0ead2a-SPEC-005 display=SPEC-005 run=issue-0013-6bae8d27-58eb-43de-b942-ef48db0ead2a -->
# SPEC-005: Architect spec

- Issue: #13
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0013-issue-0013-6bae8d27-58eb-43de-b942-ef48db0ead2a-SPEC-005
- Agent: architect
- Run: issue-0013-6bae8d27-58eb-43de-b942-ef48db0ead2a
- Created: 2026-07-25T01:59:01.399Z

## Summary

Spec

## Body

# Spec

Proposed content for `docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md`:

```markdown
# Spec: Harden Edge Functions Against Baked-In Anon Key Quota Abuse

## Assumptions

1. Local mode must remain a no-account UX: no sign-up screen, no prompts, and no visible auth concept.
2. Supabase anonymous sign-ins are acceptable as an implementation detail for local mode.
3. The shipped Supabase anon key may remain public, but it must not be sufficient by itself to consume Azure AI Foundry quota through Edge Functions.
4. Supabase dashboard configuration is in scope for deployment notes, but code changes should make the client and functions compatible with JWT verification.
5. The preferred solution is anonymous JWTs plus server-side request caps; IP rate limiting is a fallback or defense-in-depth, not the primary implementation.

## Objective

Prevent direct abuse of the `transcribe` and `cleanup` Supabase Edge Functions by callers who only extract `VITE_SUPABASE_ANON_KEY` from the shipped Verbatim AI bundle.

Success means:

- A request using only the baked-in anon key is rejected before it can consume Azure quota.
- Local-mode users still use transcription and cleanup without creating an account.
- Cloud-mode users continue to authenticate with their normal Supabase session.
- Edge Functions enforce server-side limits for request body size and audio duration.
- The implementation is testable and has clear deployment requirements.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- React/TypeScript frontend under `src/`.
- Rust backend under `src-tauri/`.
- Supabase Edge Functions under `supabase/functions/`.
- Two app windows:
  - `main` settings/management UI.
  - `overlay` recording/transcription UI.

Relevant existing architecture:

- `src/lib/appMode.ts` stores app mode in localStorage using key `sw.app.mode`.
- Local mode currently means no Supabase auth account.
- Cloud mode uses Supabase auth and synced Postgres data.
- `src/lib/ai/index.ts` contains `SupabaseAIProvider` and provider selection via `getActiveProvider(mode?)`.
- The recording flow sends captured audio from the overlay to the active AI provider.
- Edge Functions `transcribe` and `cleanup` proxy Azure AI Foundry-backed transcription/cleanup.
- The functions have historically been deployed with `--no-verify-jwt` so local-mode users can call them with the anon key.

## Problem

The anon key is intentionally public in Supabase client applications and is baked into the shipped desktop bundle. If the Edge Functions accept only the anon key, anyone who extracts it can call `transcribe` or `cleanup` directly and burn Azure quota.

The current risk is amplified by the absence of server-side request-size and audio-duration limits.

## Target Architecture

### Authentication Model

Use Supabase JWT verification for both Edge Functions.

- Cloud mode:
  - Use the existing authenticated Supabase session access token.
  - Send `Authorization: Bearer <user-access-token>` to Edge Functions.

- Local mode:
  - At first launch or first provider use, create or recover a Supabase anonymous session using Supabase Auth anonymous sign-in.
  - Persist the anonymous session through Supabase client/session storage.
  - Send `Authorization: Bearer <anonymous-access-token>` to Edge Functions.
  - Do not show sign-up prompts or account UI.

The anon key remains used only as the Supabase client API key, not as the bearer token that authorizes quota-consuming function calls.

### Edge Function Authorization

Deploy these functions with JWT verification enabled:

- `supabase/functions/transcribe`
- `supabase/functions/cleanup`

Deployment must not use `--no-verify-jwt`.

Each function should rely on Supabase JWT verification and should treat unauthenticated requests as rejected before any Azure call is made.

### Server-Side Caps

Add hard limits before calling Azure:

- Maximum request body size for `transcribe`.
- Maximum accepted audio duration for `transcribe`.
- Maximum request body size / text length for `cleanup`.

Limits should be centralized or consistently named so future functions do not diverge silently.

Recommended initial limits:

- `transcribe` body size: reject bodies above a conservative audio upload cap suitable for intended recording length.
- `transcribe` audio duration: reject absurd or malformed duration metadata server-side.
- `cleanup` text input: reject very large text payloads before LLM cleanup.

Exact values should be documented in constants and tests.

### Optional Defense-in-Depth

If anonymous JWTs cannot be enabled immediately, add per-IP or per-user rate limiting using a durable store such as Supabase Postgres or Upstash.

This is not a replacement for JWT verification unless anonymous sign-ins are blocked by product or deployment constraints.

## Implementation Scope

### Frontend

Files likely touched:

- `src/lib/appMode.ts`
- `src/lib/ai/index.ts`
- Supabase auth/client helper files if present

Required behavior:

- Add a helper that returns a valid Edge Function bearer token.
- In cloud mode, require the current authenticated user session token.
- In local mode, ensure an anonymous Supabase session exists and return its access token.
- Do not silently fall back to `VITE_SUPABASE_ANON_KEY` as a bearer token.
- Surface auth/session failures through existing provider error paths.

Example shape:

```ts
async function getEdgeFunctionAuthHeaders(): Promise<Record<string, string>> {
  const session = await getOrCreateModeAppropriateSession();

  if (!session?.access_token) {
    throw new Error("Missing Supabase session for Edge Function request");
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}
```

### Edge Functions

Files likely touched:

- `supabase/functions/transcribe/index.ts`
- `supabase/functions/cleanup/index.ts`
- shared function utilities if they exist or are introduced

Required behavior:

- Reject oversized requests before parsing expensive payloads when possible.
- Validate declared audio duration, file metadata, or decoded duration where available.
- Reject malformed, missing, or absurd inputs with clear `4xx` responses.
- Never call Azure if auth or limits fail.
- Keep error responses non-sensitive; do not leak Azure keys, internal endpoints, stack traces, or raw request data.

### Supabase Configuration / Deployment

Required dashboard setting:

- Enable Supabase Auth anonymous sign-ins for the project.

Required deployment behavior:

```bash
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Do not deploy these functions with:

```bash
--no-verify-jwt
```

## Commands

Repository validation:

```bash
pnpm lint
pnpm build
```

Supabase function deployment:

```bash
supabase functions deploy transcribe
supabase functions deploy cleanup
```

If Edge Function tests exist or are added using Deno:

```bash
deno test supabase/functions
```

## Testing Strategy

### Unit / Integration Tests

Add or update tests for:

1. Local-mode anonymous session creation
   - Given app mode is local and no session exists, the client creates an anonymous Supabase session.
   - The returned Edge Function headers use the anonymous access token.
   - The anon key is not used as `Authorization: Bearer`.

2. Cloud-mode session usage
   - Given app mode is cloud and a user session exists, the client uses that session access token.
   - Missing cloud session fails explicitly through existing error handling.

3. Edge Function auth behavior
   - Request with only anon key bearer is rejected once JWT verification is enabled.
   - Request without `Authorization` is rejected.
   - Request with a valid Supabase JWT reaches input validation.

4. Request-size caps
   - Oversized `transcribe` body returns `413` or an equivalent documented `4xx`.
   - Oversized `cleanup` input returns a documented `4xx`.
   - Rejected requests do not call Azure.

5. Audio-duration caps
   - Valid short audio is accepted.
   - Absurd duration metadata is rejected.
   - Missing or malformed duration metadata is handled explicitly.

### Manual Verification

Manual smoke paths:

1. Local mode
   - Fresh install/profile with no user-created account.
   - Start recording from overlay.
   - Stop recording.
   - Confirm transcription and cleanup complete without sign-up or prompts.

2. Cloud mode
   - Sign in normally.
   - Record and transcribe.
   - Confirm existing synced-mode behavior still works.

3. Direct abuse attempt
   - Call `transcribe` with only the anon key as bearer.
   - Confirm rejection before Azure work.
   - Call `cleanup` with only the anon key as bearer.
   - Confirm rejection before Azure work.

## Screenshots / Evidence

No product UI screenshot is expected if the implementation keeps local-mode UX unchanged.

Required PR evidence instead:

- Screenshot or terminal capture showing local-mode recording still works without account prompts.
- Screenshot or terminal capture of direct anon-key-only request being rejected.
- Screenshot or terminal capture of oversized request rejection.
- Supabase dashboard/deployment note confirming anonymous sign-ins are enabled and functions are deployed without `--no-verify-jwt`.

## Security Requirements

Always:

- Treat the Supabase anon key as public.
- Use real Supabase JWTs for quota-consuming Edge Function calls.
- Reject unauthenticated requests before any Azure call.
- Enforce body-size and input-duration limits server-side.
- Keep Azure credentials only in Edge Function secrets/environment.
- Return minimal error responses.

Never:

- Use `VITE_SUPABASE_ANON_KEY` as a bearer token for `transcribe` or `cleanup`.
- Add client-side-only limits as the sole protection.
- Log raw audio, transcripts, bearer tokens, Supabase sessions, Azure keys, or full request bodies.
- Swallow auth failures and retry with the anon key.
- Reintroduce `--no-verify-jwt` for these functions.

Ask first:

- Adding a new paid third-party rate-limiting service.
- Changing Supabase schema for durable rate-limit counters.
- Adding new visible auth/account UX to local mode.

## Implementation Tasks

1. Add mode-aware Edge Function auth helper
   - Files: `src/lib/appMode.ts`, `src/lib/ai/index.ts`, auth helper files if present.
   - Acceptance: local mode obtains an anonymous session; cloud mode uses user session; anon key is never used as bearer.
   - Verify: unit tests for local/cloud header generation.

2. Wire Supabase provider calls to session bearer tokens
   - Files: `src/lib/ai/index.ts`.
   - Acceptance: `transcribe` and `cleanup` requests send `Authorization: Bearer <session access token>`.
   - Verify: provider tests or mocked fetch assertions.

3. Harden `transcribe`
   - Files: `supabase/functions/transcribe`.
   - Acceptance: oversized bodies and absurd audio durations are rejected before Azure calls.
   - Verify: Edge Function tests for valid, oversized, and malformed inputs.

4. Harden `cleanup`
   - Files: `supabase/functions/cleanup`.
   - Acceptance: oversized cleanup payloads are rejected before Azure calls.
   - Verify: Edge Function tests for valid and oversized inputs.

5. Update deployment documentation
   - Files: relevant docs or this spec’s deployment section.
   - Acceptance: deployment commands omit `--no-verify-jwt`; anonymous sign-ins requirement is documented.
   - Verify: reviewer can follow deployment steps without ambiguity.

## Acceptance Criteria

- Requests to `transcribe` and `cleanup` with only the baked-in anon key are rejected before Azure calls.
- Local-mode users can transcribe and clean up text without creating an account or seeing new prompts.
- Cloud-mode users continue to use their authenticated Supabase session.
- Edge Functions are deployed with JWT verification enabled.
- Server-side request-size caps exist for both functions.
- Server-side audio-duration validation exists for transcription.
- Tests cover auth-token selection, anon-key-only rejection, oversized payload rejection, and normal local/cloud success paths.
- No secrets, bearer tokens, raw audio, or full request bodies are logged.

## Out of Scope

- Redesigning local/cloud mode UX.
- Building account management UI for anonymous users.
- Changing Azure provider behavior beyond preventing unauthorized/quota-abusive calls.
- Implementing broad product-level billing or quota dashboards.
```

