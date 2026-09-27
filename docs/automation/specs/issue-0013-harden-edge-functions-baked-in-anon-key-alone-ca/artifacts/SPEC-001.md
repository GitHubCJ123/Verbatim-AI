<!-- verbatim-ai:artifact:v1 issue=13 phase=spec id=issue-0013-issue-0013-0e8497d0-fa96-4e1c-b927-e021dd52ac29-SPEC-001 display=SPEC-001 run=issue-0013-0e8497d0-fa96-4e1c-b927-e021dd52ac29 -->
# SPEC-001: Architect spec

- Issue: #13
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0013-issue-0013-0e8497d0-fa96-4e1c-b927-e021dd52ac29-SPEC-001
- Agent: architect
- Run: issue-0013-0e8497d0-fa96-4e1c-b927-e021dd52ac29
- Created: 2026-07-24T09:41:58.274Z

## Summary

Spec

## Body

# Spec

● skill(doc-coauthoring)

I’ll ground the spec in the current repo surfaces first, using read-only inspection only.

/ Search (glob)
  │ "supabase/functions/**/*"
  └ 3 files found

/ Search (glob)
  │ "docs/improvement-plan/05-security-privacy.md"
  └ 1 file found

/ Search (glob)
  │ "src/lib/**/*.{ts,tsx}"
  └ 36 files found

/ Search (grep)
  │ "getAuthHeaders|functions.invoke|transcribe|cleanup|VITE_SUPABASE_ANON_KEY|--no-verify-jwt|anony
  │ mous|signInAnonymously|app.mode|sw.app.mode" in {src,supabase,docs}/**/*
  └ 7 lines found

I found the relevant Edge Function and frontend auth/provider files; I’ll read those specific surfaces now.

● Read index.ts
  │ supabase/functions/cleanup/index.ts
  └ 159 lines read

● Read appMode.ts
  │ src/lib/appMode.ts
  └ 34 lines read

● Read useAuth.ts
  │ src/lib/store/useAuth.ts
  └ 80 lines read

● Read index.ts
  │ src/lib/ai/index.ts
  └ 334 lines read

● Read README.md
  │ supabase/functions/README.md
  └ 28 lines read

● Read package.json
  └ 75 lines read

● Read index.ts
  │ supabase/functions/transcribe/index.ts
  └ 122 lines read

● Read supabase.ts
  │ src/lib/supabase.ts
  └ 29 lines read

● Read 05-security-privacy.md
  │ docs/improvement-plan/05-security-privacy.md
  └ L1:220 (96 lines read)

I’ll check existing test patterns and any deployment references so the proposed spec matches repo conventions.

/ Search (glob)
  │ "supabase/**/*.toml"
  └ 1 file found

/ Search (glob)
  │ "**/vitest*.{ts,js,mts,cts}"
  └ No matches found

/ Search (glob)
  │ "**/*.{test,spec}.{ts,tsx}"
  └ 2 files found

/ Search (grep)
  │ "supabase functions
  │ deploy|--no-verify-jwt|signInAnonymously|auth\.signIn|getAuthHeaders|cleanup\(|transcribe\(" in
  │ {src,supabase,docs,.github}/**/*
  └ 57 lines found

There is already automation context for this issue; I’ll align the proposed `spec.md` with nearby spec style and avoid duplicating resolved artifacts blindly.

● Read PRD-001.md
  │ docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/artifacts/PRD-
  │ 001.md
  └ 66 lines read

● Read AIProvider.ts
  │ src/lib/ai/AIProvider.ts
  └ 57 lines read

● Read config.toml
  │ supabase/config.toml
  └ L1:220 (220 lines read)

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ L130:190 (61 lines read)

● Read requirements-review.md
  │ docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/requirements-r
  │ eview.md
  └ 49 lines read

● Read spec.md
  │ docs/automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md
  └ L1:180 (180 lines read)

● Read audio.ts
  │ src/lib/audio.ts
  └ L1:120 (120 lines read)

● Read audio.ts
  │ src/lib/audio.ts
  └ L180:290 (96 lines read)

/ Search (grep)
  │ "duration|max|MediaRecorder|audio/webm|record" (src/lib/audio.ts)
  └ 21 lines found

Proposed content for `docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md`:

```markdown
# Spec: Issue 0013 - Harden Edge Functions Against Baked-In Anon-Key Abuse

## Objective

Harden the `transcribe` and `cleanup` Supabase Edge Functions so the shipped `VITE_SUPABASE_ANON_KEY` is not sufficient to consume Verbatim AI's Azure AI Foundry quota.

Success means:

- Local-mode users still use cloud-backed transcription/cleanup when configured with no account-creation prompt and no visible UX change.
- Edge Functions require a real Supabase Auth JWT, including anonymous JWTs for local mode.
- Requests that present only the baked-in anon key are rejected before Azure is called.
- Server-side request size, audio duration, and cleanup input limits prevent accidental or malicious oversized work.
- Abuse is throttled per authenticated user, with anonymous sign-in rate limits enabled at the Supabase project level.

## Assumptions

1. Supabase anonymous sign-ins are acceptable product behavior for "local mode" because users do not create or manage an account.
2. Anonymous Supabase users are implementation credentials only; they must not make the app appear signed in to a cloud/account-sync account.
3. Supabase remains the control plane for Auth and Edge Functions.
4. Edge Functions should be redeployed without `--no-verify-jwt`; JWT verification should happen at the Supabase gateway before function code runs.
5. A small Supabase DB migration for quota counters is acceptable because per-user rate limiting needs persistent shared state.
6. Limits should be conservative, configurable by environment variables where practical, and safe by default.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with a React/TypeScript frontend and Supabase Edge Functions that proxy Azure AI Foundry.

Relevant current surfaces:

- `src/lib/appMode.ts`
  - Stores app mode in `localStorage` key `sw.app.mode`.
  - Supports `"local"` and `"cloud"`.
  - Current comments say local mode calls Edge Functions with the anon key and functions are deployed with `--no-verify-jwt`.

- `src/lib/supabase.ts`
  - Creates a single Supabase client from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
  - Auth persistence and token refresh are already enabled.

- `src/lib/store/useAuth.ts`
  - Initializes from `supabase.auth.getSession()`.
  - Treats any Supabase session as the current `user`.
  - Needs to distinguish anonymous implementation sessions from real user-created cloud accounts.

- `src/lib/ai/index.ts`
  - `getAuthHeaders()` currently sends the anon key as the bearer token in local mode.
  - Cloud mode requires an existing Supabase session.
  - `SupabaseAIProvider.transcribe()` posts multipart audio to `/functions/v1/transcribe`.
  - `SupabaseAIProvider.cleanup()` posts JSON to `/functions/v1/cleanup` and streams SSE back.

- `supabase/functions/transcribe/index.ts`
  - Accepts multipart `audio`, optional `language`, and optional `vocabularyHints`.
  - Forwards audio to Azure transcription.
  - Does not currently enforce body size, audio duration, or per-user rate limits in function code.

- `supabase/functions/cleanup/index.ts`
  - Accepts JSON cleanup input.
  - Streams Azure chat-completion SSE back to the client.
  - Does not currently enforce request body size, field length caps, or per-user rate limits in function code.

- `supabase/config.toml`
  - `[auth] enable_anonymous_sign_ins = false` locally today.
  - `[auth.rate_limit] anonymous_users = 30` exists and should be tuned/enabled alongside anonymous sign-ins.

- `supabase/functions/README.md`
  - Shows deploy commands without `--no-verify-jwt` and says functions are JWT-protected by default.
  - This conflicts with app comments and issue context; implementation should make the deployed reality match the protected README.

- `docs/improvement-plan/05-security-privacy.md`
  - Finding F2 identifies anon-key Edge Function access as the next security/privacy hardening item.
  - F1/F3/F5 are documented as fixed.

## Tech Stack

- Desktop shell: Tauri 2
- Frontend: React 19 + TypeScript + Vite
- State: Zustand + `localStorage`
- Auth/functions/database: Supabase
- Cloud AI: Azure AI Foundry via Supabase Edge Functions
- Tests: Vitest for frontend TypeScript; Deno tests or extracted pure helper tests for Edge Function validation

## Commands

Implementation validation commands:

```bash
pnpm lint
pnpm test
pnpm build
```

Supabase local/deploy commands for the implementing engineer:

```bash
supabase db push
supabase functions deploy transcribe
supabase functions deploy cleanup
```

The `transcribe` and `cleanup` deploy commands must not include `--no-verify-jwt`.

If Edge Function helper tests are added under `supabase/functions`, validate them with:

```bash
deno test --allow-env supabase/functions
```

## Architecture

### 1. Anonymous Auth for Local Mode

Add a small auth helper used by cloud AI calls:

- Suggested location: `src/lib/edgeAuth.ts` or `src/lib/ai/edgeAuth.ts`.
- Responsibility: return a valid Supabase access token for Edge Function calls.
- Behavior:
  - If Supabase is not configured, keep the existing clear error.
  - If app mode is `"cloud"`:
    - Require a non-anonymous Supabase session.
    - Throw `"Not signed in."` or an equivalent existing error if missing.
  - If app mode is `"local"`:
    - Reuse any existing valid Supabase session.
    - If no session exists, call `supabase.auth.signInAnonymously()`.
    - Return the anonymous session access token.
    - Do not prompt, navigate, toast, or expose account UI.
  - If a stored anonymous session expires, rely on Supabase auto-refresh; if refresh fails, sign in anonymously again.

`getAuthHeaders()` in `src/lib/ai/index.ts` should always send:

```ts
{
  Authorization: `Bearer ${session.access_token}`,
  apikey: supabaseAnonKey(),
}
```

It should never use `VITE_SUPABASE_ANON_KEY` as the bearer token.

### 2. Anonymous Sessions Are Not Cloud Accounts

Because `useAuth.ts` currently treats any session as `user`, implementation must prevent anonymous implementation sessions from unlocking account/sync UX.

Required behavior:

- Add a derived helper such as `isAnonymousUser(user)` using Supabase's anonymous-user marker.
- `useAuth` may still store the raw session, but cloud/account surfaces must distinguish:
  - `session`: any Supabase session, including anonymous.
  - `accountUser`: non-anonymous user only.
  - `isAnonymousSession`: true for local-mode implementation credentials.
- Cloud sync, account pages, and AuthGate-style checks must require a non-anonymous account.
- Switching from local mode to cloud mode must still prompt for normal sign-in/sign-up.
- Signing into a real account may replace the anonymous session; that is acceptable.

### 3. Edge Function JWT Verification

Redeploy `transcribe` and `cleanup` with Supabase JWT verification enabled.

Expected behavior:

- Missing `Authorization` header: rejected before Azure is called.
- `Authorization: Bearer <anon key>`: rejected before Azure is called.
- `Authorization: Bearer <valid anonymous access token>`: allowed subject to limits.
- `Authorization: Bearer <valid real user access token>`: allowed subject to limits.

Update comments/docs so `appMode.ts`, `supabase/functions/README.md`, and function comments agree that Edge Functions require JWTs.

### 4. Per-User Rate Limits

Add persistent per-user quota checks before any Azure request.

Recommended DB shape:

```sql
create table public.edge_function_usage_windows (
  user_id uuid not null,
  function_name text not null,
  window_start timestamptz not null,
  window_kind text not null,
  request_count integer not null default 0,
  unit_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, function_name, window_kind, window_start)
);
```

Recommended RPC:

```sql
consume_edge_function_quota(
  p_function_name text,
  p_window_kind text,
  p_unit_count integer,
  p_request_limit integer,
  p_unit_limit integer
) returns boolean
```

The RPC should:

- Use `auth.uid()` as the user id.
- Reject unauthenticated callers.
- Atomically increment the current window.
- Return false when the request or unit limit would be exceeded.
- Avoid requiring the Edge Function to use the service-role key.

Suggested initial configurable defaults:

| Function | Window | Request limit | Unit limit |
|---|---:|---:|---:|
| `transcribe` | hour | 60 requests | 60 audio minutes |
| `transcribe` | day | 240 requests | 240 audio minutes |
| `cleanup` | hour | 120 requests | 500,000 input chars |
| `cleanup` | day | 600 requests | 2,000,000 input chars |

If product wants different quota levels, keep defaults in Edge Function constants or environment variables so they can be tuned without changing client behavior.

### 5. Request Size and Duration Caps

Add shared validation helpers where practical.

#### `transcribe`

Reject before calling Azure when:

- `content-length` is present and exceeds `MAX_TRANSCRIBE_BODY_BYTES`.
- Parsed `audio.size` exceeds `MAX_AUDIO_BYTES`.
- Audio MIME type is unsupported.
- Server-derived duration exceeds `MAX_AUDIO_DURATION_MS`.
- Duration cannot be determined for formats the app is expected to produce.

Suggested defaults:

```ts
const MAX_TRANSCRIBE_BODY_BYTES = 26 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 10 * 60 * 1000;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/wav",
]);
```

The app currently records with `MediaRecorder` and prefers WebM/Opus, then Ogg/Opus, then WAV. Server duration validation should support those app-produced formats or reject unsupported ones with a clear 400/413 response.

Do not rely on client-provided duration as the only enforcement mechanism.

#### `cleanup`

Reject before calling Azure when:

- `content-length` exceeds `MAX_CLEANUP_BODY_BYTES`.
- Actual JSON body bytes exceed `MAX_CLEANUP_BODY_BYTES`.
- `rawText`, `systemPrompt`, `modeName`, `modeDescription`, `vocabulary`, or `targetLanguage` exceed field caps.
- `temperature` is outside the allowed model range.

Suggested defaults:

```ts
const MAX_CLEANUP_BODY_BYTES = 256 * 1024;
const MAX_RAW_TEXT_CHARS = 50_000;
const MAX_SYSTEM_PROMPT_CHARS = 8_000;
const MAX_MODE_NAME_CHARS = 200;
const MAX_MODE_DESCRIPTION_CHARS = 2_000;
const MAX_VOCABULARY_TERMS = 500;
const MAX_VOCABULARY_TERM_CHARS = 100;
```

Return `413` for oversized bodies/audio and `400` for malformed or unsupported input.

### 6. Supabase Project Configuration

Required project/dashboard changes:

- Enable anonymous sign-ins.
- Set anonymous sign-in rate limits to a conservative value.
- Confirm `transcribe` and `cleanup` require JWT verification.
- Confirm Azure secrets remain server-side only.

Local `supabase/config.toml` should mirror the intended local behavior:

```toml
[auth]
enable_anonymous_sign_ins = true

[auth.rate_limit]
anonymous_users = 30
```

Tune `anonymous_users` lower if abuse testing shows anonymous account creation is too permissive.

## Security Requirements

- Never commit Azure keys, Supabase service-role keys, JWT signing secrets, or extracted tokens.
- The shipped anon key may remain public, but it must not authorize Edge Function work by itself.
- Edge Functions must perform all validation and quota checks before calling Azure.
- Quota failures must return `429` and must not call Azure.
- Oversized requests must return `413` and must not call Azure.
- Malformed requests must return `400` and must not call Azure.
- Error responses must not include secrets, full stack traces, JWTs, or full user content.
- CORS may remain broad for the desktop app, but authorization must not depend on CORS.
- Anonymous sessions must not grant account sync or cloud-account UX.
- Rate-limit counters must be scoped by authenticated `auth.uid()`.
- Tests should prove Azure `fetch` is not invoked on rejected requests.

## Code Style

Prefer small pure helpers for validation and quota calculations so they can be tested without standing up Supabase.

Example style:

```ts
const MAX_RAW_TEXT_CHARS = 50_000;

function validateCleanupPayload(payload: CleanupRequest): ValidationResult {
  if (!payload.rawText || !payload.systemPrompt || !payload.modeName) {
    return { ok: false, status: 400, error: "Missing rawText, systemPrompt, or modeName." };
  }

  if (payload.rawText.length > MAX_RAW_TEXT_CHARS) {
    return { ok: false, status: 413, error: "rawText exceeds the maximum length." };
  }

  return { ok: true };
}
```

Conventions:

- Use explicit constants for limits.
- Keep error messages actionable but not data-leaky.
- Avoid broad silent catches.
- Avoid `as any`; model request and validation types directly.
- Keep frontend auth behavior in one helper instead of duplicating session logic across providers.

## Testing Strategy

### Frontend Unit Tests

Add targeted Vitest coverage for the auth-header helper.

Scenarios:

- Local mode with no session calls `signInAnonymously()` and returns the anonymous access token as bearer.
- Local mode with an existing session reuses the existing access token.
- Cloud mode with no session throws the existing signed-out error.
- Cloud mode with an anonymous session does not satisfy real account requirements.
- `getAuthHeaders()` never returns the anon key as the bearer token.

### Edge Function Unit Tests

Extract validation helpers from `transcribe` and `cleanup` so they can be tested directly.

Scenarios:

- `cleanup` rejects missing required fields.
- `cleanup` rejects oversized JSON/body fields.
- `cleanup` rejects invalid temperature.
- `transcribe` rejects oversized `content-length`.
- `transcribe` rejects oversized audio file size.
- `transcribe` rejects unsupported audio MIME types.
- `transcribe` rejects audio duration above the configured cap.
- Quota helper maps quota failure to `429`.
- Rejected requests do not invoke the Azure fetch path.

### Integration / Manual Verification

Verify against a deployed or locally served Supabase stack:

1. Request with only `apikey: <anon key>` and `Authorization: Bearer <anon key>` is rejected.
2. Local-mode app can complete transcription/cleanup with no sign-up prompt.
3. Supabase Auth shows an anonymous user/session created for local mode.
4. Account/sync UI does not treat the anonymous session as a real signed-in account.
5. Real signed-in cloud users still call both functions successfully.
6. Oversized cleanup JSON returns `413`.
7. Oversized or too-long audio returns `413`.
8. Rate-limit exhaustion returns `429`.

## Screenshots / Visual Evidence

This issue is primarily API/security behavior, but capture screenshots for the no-UX-regression claim:

- Local-mode settings or home screen before first cloud AI call: no sign-in prompt.
- Local-mode settings or home screen after anonymous session creation: still no account prompt and no visible "signed in" state.
- Account/sign-in surface after anonymous session exists: still asks for real sign-in/sign-up for cloud sync.
- Successful local-mode dictation flow after the hardening change, showing the overlay returns normal output.

For API rejection/rate-limit behavior, attach terminal output or HTTP client captures rather than screenshots.

## Acceptance Criteria

- `transcribe` and `cleanup` are deployed with JWT verification enabled.
- `Authorization: Bearer <VITE_SUPABASE_ANON_KEY>` does not authorize either function.
- Local mode obtains or reuses a Supabase anonymous session automatically and sends that session access token to Edge Functions.
- Local-mode users see no sign-up prompt, no new onboarding step, and no visible account state caused by anonymous auth.
- Cloud/account-sync surfaces require non-anonymous users.
- Both functions enforce server-side size limits before calling Azure.
- `transcribe` enforces a server-derived audio duration cap before calling Azure.
- Both functions enforce per-user quota/rate limits and return `429` without calling Azure when exceeded.
- Error responses do not expose secrets, JWTs, stack traces, or full user content.
- Frontend tests cover anonymous-token header behavior.
- Edge Function tests cover auth-adjacent validation, request caps, duration caps, and quota rejection.
- `pnpm lint`, `pnpm test`, and `pnpm build` pass.

## Boundaries

- Always:
  - Keep Azure secrets server-side.
  - Validate and rate-limit before Azure calls.
  - Preserve local-mode UX.
  - Treat anonymous sessions as implementation credentials, not accounts.
  - Update comments/docs that still describe anon-key bearer access.

- Ask first:
  - Changing product quota levels after initial safe defaults.
  - Adding a third-party rate-limit dependency such as Upstash.
  - Changing billing/subscription entitlement behavior.
  - Removing local-mode cloud AI support entirely.

- Never:
  - Reintroduce `--no-verify-jwt` for `transcribe` or `cleanup`.
  - Use the anon key as an `Authorization` bearer token.
  - Commit secrets or captured JWTs.
  - Depend on client-provided duration as the only duration cap.
  - Let anonymous users unlock cloud account sync.
```

