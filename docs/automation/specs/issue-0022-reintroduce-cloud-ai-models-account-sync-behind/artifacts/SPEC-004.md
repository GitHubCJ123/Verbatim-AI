<!-- verbatim-ai:artifact:v1 issue=22 phase=spec id=issue-0022-issue-0022-a26d1e0c-f56d-4594-a8b5-1a1223740260-SPEC-004 display=SPEC-004 run=issue-0022-a26d1e0c-f56d-4594-a8b5-1a1223740260 -->
# SPEC-004: Architect spec

- Issue: #22
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0022-issue-0022-a26d1e0c-f56d-4594-a8b5-1a1223740260-SPEC-004
- Agent: architect
- Run: issue-0022-a26d1e0c-f56d-4594-a8b5-1a1223740260
- Created: 2026-07-24T21:19:29.456Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue #22 — Reintroduce Cloud AI Models + Account Sync Behind Subscription Entitlements

## Assumptions

1. Stripe Checkout + Stripe Customer Portal is the default billing provider unless product decides otherwise.
2. Cloud AI usage requires a signed-in Supabase user; anonymous/local-only users cannot call paid cloud inference.
3. Supabase remains the entitlement source of truth after billing webhooks update subscription state.
4. Local transcription/cleanup remains free and fully usable without an account.
5. This spec follows issue #21, where cloud UI is hidden but the cloud code remains in the repo.

## Problem

Verbatim AI previously had cloud-backed transcription, cleanup, auth, and sync surfaces. Issue #21 hides those surfaces to ship a local-only app while preserving the code. Issue #22 reintroduces cloud functionality safely by requiring an active subscription entitlement before users can see, select, or invoke cloud features.

The core risk is exposing paid Azure inference through client-only gating or anon-key Edge Functions. The implementation must enforce entitlement in both the client UX and Supabase Edge Functions.

## Current Repo Facts

- App is a Tauri 2 desktop app with React/TypeScript frontend and Rust backend.
- There are two Tauri windows:
  - `main` for settings/account/onboarding UI.
  - `overlay` for recording/transcription flow.
- Cloud/local mode state is currently represented by `src/lib/appMode.ts` using `localStorage` key `sw.app.mode`.
- State uses Zustand stores under `src/lib/store/`, with `localStorage` cache keys prefixed `sw.` so the overlay can read synchronously.
- AI providers are selected through `src/lib/ai/index.ts`.
- Existing providers include:
  - `SupabaseAIProvider` for Azure-backed cloud transcription/cleanup via Supabase Edge Functions.
  - `LocalWhisperProvider` and `ParakeetProvider` for local transcription.
  - `OllamaProvider` for local cleanup.
- Existing cloud-related surfaces include `useAuth`, `Account`, `AuthGate`, `MigrationPicker`, Supabase Edge Functions, and provider settings.
- Supabase Edge Functions currently include `transcribe` and `cleanup`; existing deployment notes mention `--no-verify-jwt`, which is not acceptable for paid cloud inference.
- The app already supports local-vs-cloud behavior conceptually, but entitlement and billing enforcement are missing.

## Objective

Reintroduce cloud AI models and account sync as a paid tier while preserving the free local-only experience.

Users without an active entitlement should experience the same local-only app introduced by #21: no cloud provider options, no account-sync dead ends, and no accidental cloud calls.

Subscribed users should be able to sign in, manage billing, select cloud transcription/cleanup, sync account-backed data, and use Azure-backed transcription/cleanup through server-side entitlement-checked Edge Functions.

## Tech Stack

- Frontend: React, TypeScript, Zustand, Vite.
- Desktop shell: Tauri 2, Rust.
- Backend: Supabase Auth, Postgres, Edge Functions.
- Cloud inference: Azure Whisper transcription and Azure GPT cleanup behind Supabase Edge Functions.
- Billing: Stripe Checkout, Stripe Customer Portal, Stripe webhooks.
- Local inference remains via existing local providers.

## Commands

```bash
pnpm install
pnpm build
pnpm lint
pnpm tauri dev
pnpm tauri build
supabase db push
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Edge Function deployment for paid paths must no longer rely on `--no-verify-jwt` for entitlement-protected inference.

## Architecture

### Entitlement Model

Add Supabase-backed subscription and entitlement records.

Recommended tables:

```sql
subscriptions (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  stripe_customer_id text not null,
  stripe_subscription_id text unique,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

entitlements (
  user_id uuid primary key references auth.users(id),
  cloud_ai_enabled boolean not null default false,
  cloud_sync_enabled boolean not null default false,
  plan text not null default 'free',
  source text not null,
  valid_until timestamptz,
  updated_at timestamptz not null default now()
)

usage_events (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  feature text not null,
  provider text not null,
  input_units integer,
  output_units integer,
  created_at timestamptz not null default now()
)
```

`entitlements` is the read-optimized source for the app and Edge Functions. `subscriptions` mirrors Stripe state. `usage_events` supports future caps and auditing.

### Billing Flow

1. User signs in.
2. User opens Account/Upgrade UI.
3. Client calls a Supabase Edge Function to create a Stripe Checkout session.
4. Stripe redirects user to Checkout.
5. Stripe webhook updates `subscriptions`.
6. Webhook derives and writes `entitlements`.
7. Client refreshes entitlement state.
8. Cloud AI and sync UI become available.

Customer Portal should support cancellation, payment method updates, and plan management.

### Client Entitlement Flow

Add an entitlement store/hook, likely under `src/lib/store/`:

```ts
type EntitlementState = {
  cloudAiEnabled: boolean
  cloudSyncEnabled: boolean
  plan: 'free' | 'paid' | 'trial'
  validUntil: string | null
  hydrated: boolean
}
```

Client gating should use both:

- build/product flag: cloud code can be globally disabled for emergency rollback;
- runtime entitlement: user must be subscribed/trialing.

`CLOUD_FEATURES_ENABLED` should become a capability guard, not the sole source of truth.

Suggested effective check:

```ts
const canUseCloudAi =
  CLOUD_FEATURES_ENABLED &&
  auth.user != null &&
  entitlement.cloudAiEnabled
```

Cloud options must be hidden or disabled for free users depending on context:

- Provider settings: hide unavailable cloud models or show upgrade CTA.
- Per-mode overrides: prevent selecting cloud provider without entitlement.
- Onboarding: local path remains default; cloud path requires account + upgrade.
- Overlay: never starts cloud transcription unless the cached entitlement allows it.
- Provider resolver: refuses cloud provider selection when entitlement is missing, even if stale settings contain cloud values.

### Server-Side Enforcement

Supabase Edge Functions that proxy Azure must enforce entitlement before any Azure request.

Required behavior:

1. Require authenticated Supabase JWT.
2. Resolve `user_id` from verified JWT.
3. Read entitlement from Supabase using service role server-side only.
4. Reject when entitlement is missing, expired, disabled, or user is anonymous.
5. Only after entitlement passes, call Azure.
6. Record usage event after successful calls.

Server rejection should use stable status codes:

| Case | Status |
|---|---|
| Missing auth token | `401` |
| Invalid auth token | `401` |
| No active entitlement | `403` |
| Usage cap exceeded, if added | `402` or `429` |
| Azure/provider failure | `502` |
| Invalid request payload | `400` |

Edge Functions must not trust client-provided plan, entitlement, provider, or user identifiers.

### Account Sync

Cloud sync should be gated separately from cloud AI but likely included in the same paid plan.

Free users:

- keep local-only modes/vocabulary/app mappings;
- are not forced into auth;
- do not see sync-only dead ends.

Subscribed users:

- can sign in;
- can migrate local data to account-backed data through `MigrationPicker`;
- can sync modes, vocabulary, mappings, and profile data.

Downgrades must not delete local data. If a subscription lapses, the app should:

1. stop offering cloud provider choices;
2. fall back to local transcription/cleanup defaults;
3. preserve synced data locally where already cached;
4. explain that cloud sync and cloud AI require an active subscription.

## Security Requirements

- Do not expose Azure credentials to the client.
- Do not rely on client-side entitlement checks for paid inference.
- Do not deploy paid inference functions with unauthenticated anon-key access.
- Stripe webhook signature verification is mandatory.
- Stripe customer and subscription IDs must be associated with exactly one Supabase user.
- Service role keys stay server-only in Supabase function secrets.
- Entitlement decisions must be made server-side from database state, not request body fields.
- Reject stale, missing, or expired entitlement before making Azure calls.
- Avoid logging transcript audio, raw transcript text, cleanup text, auth tokens, Stripe secrets, or Azure credentials.
- Add rate limiting or usage recording hooks before enabling production paid access.
- Local cached entitlement is UX-only and must never be considered authoritative for server access.

## UX Requirements

### Free / Unsubscribed

- App remains local-only.
- Local providers remain selectable.
- Cloud AI options are hidden or marked as paid with an upgrade CTA.
- Account/sync surfaces should not create dead ends.
- Existing cloud provider selections from older app versions are automatically downgraded to local defaults.

### Subscribed / Trialing

- User can select cloud transcription and cleanup globally.
- User can select cloud transcription and cleanup per Mode.
- Account sync UI is available.
- Billing management is available from Account settings.
- Cloud calls work from the overlay recording flow.

### Lapsed / Canceled

- If subscription remains active until period end, access continues until `current_period_end`.
- After entitlement expires, cloud options are removed or disabled.
- Existing local data remains intact.
- The user sees clear downgrade messaging and an upgrade/resubscribe CTA.

## Screenshots to Capture for Review

1. Local-only free user settings screen with no cloud dead ends.
2. Upgrade/account entry point for free user.
3. Stripe Checkout handoff screen or mocked dev equivalent.
4. Subscribed user provider settings showing cloud transcription/cleanup options.
5. Per-Mode override UI showing cloud options for entitled user.
6. Overlay recording success using cloud provider.
7. Lapsed subscription state with graceful local fallback messaging.
8. Server-side rejection surfaced in UI when entitlement is missing or expired.

## Testing Strategy

### Unit Tests

Cover:

- entitlement selector logic;
- provider availability filtering;
- fallback from cloud provider to local provider when entitlement is absent;
- subscription status to entitlement derivation;
- stale localStorage cloud settings downgrade behavior.

### Integration Tests

Cover:

- signed-in subscribed user can call `transcribe`;
- signed-in unsubscribed user receives `403`;
- anonymous user receives `401`;
- expired entitlement receives `403`;
- webhook updates subscription and entitlement records;
- cancellation/lapse toggles entitlement without deleting local state.

### UI Tests / Manual QA

Cover:

- free user sees local-only experience;
- upgrade CTA appears in expected places;
- subscribed user sees cloud provider options;
- lapsed user falls back to local;
- cloud provider rejection is understandable and recoverable.

### Suggested Verification Commands

```bash
pnpm lint
pnpm build
supabase db push
supabase functions deploy transcribe
supabase functions deploy cleanup
```

If Supabase function tests exist or are added, run the targeted function test command before full app validation.

## Implementation Plan

### Phase 1 — Billing and Entitlement Foundation

- Add subscription and entitlement schema.
- Add Stripe customer/subscription mapping.
- Add webhook function with signature verification.
- Add entitlement derivation from Stripe subscription states.
- Add entitlement read endpoint or authenticated query path.

### Phase 2 — Client Entitlement Store

- Add entitlement Zustand store.
- Hydrate entitlement during app boot for signed-in users.
- Cache entitlement for UI responsiveness only.
- Add selectors for `canUseCloudAi` and `canUseCloudSync`.
- Ensure sign-out clears entitlement state.

### Phase 3 — Cloud UI Reintroduction

- Replace hard-coded cloud hiding with entitlement-aware gating.
- Restore Account/AuthGate/MigrationPicker as paid-tier entry points.
- Show cloud provider options only when entitled.
- Add upgrade CTA where cloud would otherwise be relevant.
- Ensure older persisted cloud settings are downgraded for unentitled users.

### Phase 4 — Server Enforcement

- Require verified Supabase JWT for paid `transcribe` and `cleanup`.
- Check entitlement before Azure calls.
- Add usage event recording.
- Return stable `401`/`403`/`400`/`502` errors.
- Remove unauthenticated paid inference deployment path.

### Phase 5 — Lifecycle and Failure UX

- Handle trialing, active, past_due, canceled, and expired states.
- Add graceful downgrade messaging.
- Add billing portal link.
- Add cloud rejection handling in provider code and UI.

### Phase 6 — Verification and Documentation

- Add tests for entitlement gates and Edge Function rejection.
- Document billing setup, required secrets, webhook events, and deployment steps.
- Capture screenshots listed above.
- Verify acceptance criteria end-to-end.

## Acceptance Criteria

- Free users see the same local-only experience as after #21.
- Free users cannot select cloud transcription, cloud cleanup, or cloud sync.
- Subscribed users can select and use cloud transcription and cleanup.
- Subscribed users can use account sync.
- Anonymous callers cannot invoke paid cloud Edge Functions.
- Authenticated but unentitled callers receive server-side rejection before Azure is called.
- Subscription lifecycle changes update entitlement correctly.
- Lapsed subscriptions downgrade to local defaults without deleting local data.
- Billing setup, entitlement model, Edge Function enforcement, and lifecycle behavior are documented.
- Screenshots are captured for free, subscribed, and lapsed states.

## Open Questions

1. Confirm billing provider: Stripe Checkout/Portal versus RevenueCat or app-store billing.
2. Confirm initial paid tier shape: cloud AI + sync bundled, or separate entitlements.
3. Decide whether to launch with usage caps or only usage recording.
4. Define trial duration and whether offline grace is allowed.
5. Decide whether cloud options should be hidden entirely for free users or shown with upgrade CTAs.
6. Confirm whether Supabase Edge Functions should be split into local/free-compatible and paid-authenticated variants, or migrated in place.
```

