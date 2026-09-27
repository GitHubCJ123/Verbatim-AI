<!-- verbatim-ai:artifact:v1 issue=22 phase=spec id=issue-0022-issue-0022-639d2d9e-ec45-49e2-a657-fb59a338fd93-SPEC-005 display=SPEC-005 run=issue-0022-639d2d9e-ec45-49e2-a657-fb59a338fd93 -->
# SPEC-005: Architect spec

- Issue: #22
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0022-issue-0022-639d2d9e-ec45-49e2-a657-fb59a338fd93-SPEC-005
- Agent: architect
- Run: issue-0022-639d2d9e-ec45-49e2-a657-fb59a338fd93
- Created: 2026-07-25T01:26:40.586Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue 0022 — Reintroduce Cloud AI Models + Account Sync Behind Subscription Entitlements

## Objective

Reintroduce Verbatim AI cloud features as a paid tier while preserving the local-only free experience.

Cloud features include:

1. Azure-backed transcription through the Supabase `transcribe` Edge Function.
2. Azure/GPT-backed cleanup through the Supabase `cleanup` Edge Function.
3. Optional account-based cloud sync for modes, vocabulary, profile, and app mappings.

Success means free users continue to see a complete local-only app with no dead-end cloud UI, while subscribed users can sign in, manage billing, use cloud AI providers, and sync data. Server-side enforcement must prevent unentitled users from consuming paid Azure inference even if they bypass the UI.

## Problem

Issue #21 disables all cloud surfaces behind a static `CLOUD_FEATURES_ENABLED` flag while keeping the existing implementation intact. That avoids exposing paid cloud inference for free, but it also removes account sync and cloud models from the product.

The next version needs to re-enable those capabilities safely:

- Client UI must only expose cloud options when the user has an active entitlement.
- Supabase Edge Functions must verify entitlement before proxying to Azure.
- Subscription lifecycle changes must downgrade users cleanly without data loss.
- Local mode must remain the default free path.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with:

- Frontend: React + TypeScript in `src/`.
- Backend: Rust Tauri commands in `src-tauri/src/commands/`.
- Overlay window: `overlay.html` and `src/overlay/`.
- State: Zustand stores under `src/lib/store/`, cached to `localStorage` using `sw.*` keys.
- App mode: `src/lib/appMode.ts`, with `local` and `cloud`.
- AI provider selection: `src/lib/ai/index.ts`.
- Provider implementations:
  - `SupabaseAIProvider` for cloud transcription/cleanup through Supabase Edge Functions.
  - `LocalWhisperProvider` for local Whisper transcription.
  - `ParakeetProvider` for local Parakeet transcription.
  - `OllamaProvider` for local cleanup only.
- Existing cloud/account code:
  - `useAuth`
  - `Account`
  - `AuthGate`
  - `MigrationPicker`
  - Supabase Edge Functions: `supabase/functions/transcribe`, `supabase/functions/cleanup`
- Recording flow:
  1. Rust emits global hotkey events.
  2. `src/lib/hotkey.ts` resolves mode through `src/lib/modeResolver.ts`.
  3. `src/lib/recording-bridge.ts` shows overlay and emits `recording:start`.
  4. `src/overlay/Overlay.tsx` records audio.
  5. `getActiveProvider(mode?)` chooses transcription and cleanup providers.
  6. Rust `paste_to_target` pastes final text.

## Assumptions

1. Stripe Checkout + Stripe Customer Portal is the preferred billing path for the desktop app.
2. Supabase remains the account/session provider and database for cloud sync.
3. Cloud AI requires a signed-in account.
4. Entitlement source of truth is Supabase, populated by Stripe webhook events.
5. Edge Functions should require authenticated JWTs for paid cloud calls.
6. Local transcription/cleanup remains free and does not require an account.
7. If entitlement status cannot be refreshed, the app should fail closed for cloud calls but preserve local functionality.

## Tech Stack

- Desktop shell: Tauri 2
- Frontend: React, TypeScript, Vite
- State: Zustand + `localStorage` cache
- Backend commands: Rust
- Cloud backend: Supabase Auth, Postgres, Edge Functions
- Billing: Stripe Checkout, Stripe Customer Portal, Stripe webhooks
- Cloud AI: Azure Whisper transcription and Azure GPT cleanup via Supabase functions

## Commands

```bash
pnpm install
pnpm dev
pnpm tauri dev
pnpm build
pnpm lint
supabase db push
supabase functions deploy transcribe
supabase functions deploy cleanup
```

If a new Stripe webhook function is added:

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

Cloud inference functions should not be deployed with `--no-verify-jwt` once entitlement enforcement is implemented.

## Project Structure

```text
src/
  App.tsx
  lib/
    ai/
      index.ts
      AIProvider.ts
      localWhisper.ts
      parakeet.ts
      ollama.ts
    appMode.ts
    store/
      auth-related stores
      modes/vocabulary stores
      profile store
      app mapping store
    entitlement/
      entitlement store/hook
      entitlement refresh helpers
    billing/
      checkout and portal helpers
  components/
    account, billing, settings, onboarding, provider selection UI

src/overlay/
  Overlay.tsx

supabase/
  migrations/
    entitlement/subscription schema migrations
  functions/
    transcribe/
    cleanup/
    stripe-webhook/
    create-checkout-session/
    create-customer-portal-session/

docs/
  automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md
  billing-and-entitlements.md
```

## Proposed Architecture

### Entitlement Model

Add Supabase-backed subscription and entitlement records.

Suggested tables:

```sql
subscriptions
- id uuid primary key
- user_id uuid references auth.users(id)
- stripe_customer_id text unique
- stripe_subscription_id text unique
- status text
- current_period_end timestamptz
- cancel_at_period_end boolean
- trial_end timestamptz
- created_at timestamptz
- updated_at timestamptz

entitlements
- user_id uuid primary key references auth.users(id)
- cloud_ai_enabled boolean not null default false
- cloud_sync_enabled boolean not null default false
- plan text not null default 'free'
- status text not null
- valid_until timestamptz
- source text not null default 'stripe'
- updated_at timestamptz
```

Entitled states should include active subscriptions and active trials. Canceled subscriptions remain entitled until `current_period_end`. Lapsed, unpaid, incomplete, expired, or missing subscriptions are not entitled.

### Client Entitlement Store

Add a client entitlement store/hook, for example:

```ts
type EntitlementStatus = {
  loading: boolean;
  cloudAiEnabled: boolean;
  cloudSyncEnabled: boolean;
  plan: 'free' | 'pro';
  status:
    | 'unknown'
    | 'free'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'expired';
  validUntil?: string;
};
```

Responsibilities:

- Refresh entitlement after auth changes.
- Cache a minimal entitlement snapshot in `localStorage`.
- Fail closed for cloud features when status is unknown/stale.
- Emit clear UI state for upgrade prompts, expired access, and active paid access.
- Avoid caching secrets, tokens, Stripe payloads, or raw billing webhook data.

### Feature Gating

Replace the static cloud feature flag behavior with derived capability checks:

```ts
const canUseCloudAi =
  CLOUD_FEATURES_ENABLED &&
  auth.isSignedIn &&
  entitlement.cloudAiEnabled;

const canUseCloudSync =
  CLOUD_FEATURES_ENABLED &&
  auth.isSignedIn &&
  entitlement.cloudSyncEnabled;
```

Expected behavior:

| User state | Cloud AI options | Account sync | Local engines |
|---|---:|---:|---:|
| Signed out free user | Hidden or upgrade CTA only | Hidden or sign-in/upgrade CTA | Available |
| Signed in without subscription | Hidden or upgrade CTA only | Disabled with upgrade CTA | Available |
| Trialing/active subscriber | Available | Available | Available |
| Expired/lapsed subscriber | Removed/disabled and downgraded | Read-only or local fallback, no destructive data loss | Available |

### Provider Selection

`getActiveProvider(mode?)` should continue supporting mixed transcription/cleanup backends, but cloud provider selection must require entitlement.

If a user loses entitlement while cloud providers are selected:

- Do not delete their saved preferences.
- Runtime provider resolution should downgrade to local defaults.
- UI should display that cloud providers are unavailable until subscription is restored.
- Existing mode data should remain intact.

### Account and Sync

Cloud sync requires:

1. Signed-in Supabase account.
2. Active `cloudSyncEnabled` entitlement.

Migration flow should use the existing `MigrationPicker` as the paid-tier entry point:

- Free/local users can continue local-only.
- Upgrade flow can prompt account creation/sign-in.
- After subscribing, users may migrate local modes/vocabulary/profile/app mappings to cloud.
- Downgrade must not delete local or cloud data. The app should preserve local cached data and stop write sync if entitlement is missing.

### Billing Flow

Add Stripe-backed flows:

1. User clicks upgrade.
2. Client requests a Checkout Session from a Supabase function.
3. Function verifies authenticated Supabase user.
4. Function creates or reuses Stripe customer.
5. User completes Checkout in browser.
6. Stripe webhook updates `subscriptions` and `entitlements`.
7. Client refreshes entitlement and unlocks cloud features.

Add customer portal flow:

1. Active or previous subscriber clicks manage billing.
2. Client requests portal session.
3. Function verifies authenticated user.
4. Function returns Stripe portal URL.

Webhook handling must be idempotent and verify Stripe signatures.

### Server-Side Enforcement

`supabase/functions/transcribe` and `supabase/functions/cleanup` must enforce:

1. Valid Supabase authenticated user JWT.
2. Active cloud AI entitlement.
3. Optional usage limits if tiers include caps.
4. Request validation before invoking Azure.
5. No Azure calls when entitlement validation fails.

Unauthorized/unentitled responses should be explicit but not reveal sensitive billing internals:

```json
{
  "error": "cloud_entitlement_required",
  "message": "Cloud AI requires an active subscription."
}
```

Recommended statuses:

- `401` for missing/invalid auth.
- `403` for authenticated but unentitled.
- `429` for usage cap exceeded if metering is implemented.

## Security Requirements

- Never rely on client-side feature gates as the source of truth.
- Edge Functions must validate JWTs and entitlement before paid inference.
- Stripe webhooks must verify signatures.
- Webhook handlers must be idempotent by Stripe event ID.
- Do not persist raw Stripe payloads unless required for audit; if stored, redact sensitive fields.
- Do not expose Azure keys, Stripe secret keys, webhook secrets, Supabase service-role keys, or customer billing data to the client.
- Client should only receive minimal entitlement state.
- Local caches must not contain raw tokens, service credentials, full billing payloads, or unknown config dumps.
- Supabase RLS should prevent users from reading or mutating other users’ subscription/entitlement records.
- Server-side functions should use service-role access only inside trusted Edge Functions.
- Cloud AI request logs must avoid storing raw audio, transcripts, prompts, or generated cleanup text unless an explicit privacy-reviewed retention policy exists.

## Privacy Requirements

- Local-only users should not send audio or text to cloud AI services.
- UI copy should clearly distinguish local processing from cloud processing.
- When cloud providers are selected, users should understand audio/text is sent to Verbatim’s cloud AI backend/Azure.
- Subscription lapse should not delete user-created modes, vocabulary, or mappings.
- Screenshots and docs must use fake accounts, fake names, and fake billing data.

## Code Style

Follow existing React/TypeScript patterns and Zustand store conventions. Keep capability checks centralized instead of scattering raw subscription logic through UI components.

Example style:

```ts
export function canUseCloudAi(
  auth: AuthSnapshot,
  entitlement: EntitlementSnapshot,
): boolean {
  return auth.status === 'authenticated' && entitlement.cloudAiEnabled === true;
}
```

Avoid broad `try/catch` blocks that silently downgrade cloud calls. Downgrades should be intentional and surfaced in UI state.

## Testing Strategy

### Unit Tests

Cover:

- Entitlement status derivation from subscription state.
- Feature capability helpers.
- Provider fallback when cloud entitlement is missing.
- UI gating logic for free, signed-in-free, trialing, active, canceled, and expired users.
- Subscription lifecycle transitions.

### Supabase Function Tests

Cover:

- `transcribe` rejects missing JWT.
- `transcribe` rejects authenticated but unentitled user.
- `transcribe` does not call Azure when unentitled.
- `cleanup` rejects missing JWT.
- `cleanup` rejects authenticated but unentitled user.
- `cleanup` does not call Azure when unentitled.
- Entitled calls pass validation and invoke the expected provider path.
- Stripe webhook rejects invalid signatures.
- Stripe webhook handles duplicate events idempotently.

### Integration Tests

Cover:

- Local-only user completes recording with local providers.
- Free user does not see selectable cloud providers.
- Signed-in unsubscribed user sees upgrade path but cannot call cloud AI.
- Subscribed user sees cloud providers and can select them.
- Subscription lapse downgrades runtime provider resolution without deleting settings.
- Account sync only runs for entitled users.

### Manual QA

Cover:

1. Fresh install, no account: local-only onboarding works.
2. Signed-in free account: upgrade CTA appears, cloud options remain unavailable.
3. Checkout success: entitlement refresh unlocks cloud AI and sync.
4. Customer portal cancellation: user remains entitled until period end.
5. Period expiry: cloud options are disabled and local fallback works.
6. Offline launch with stale entitlement: local works; cloud fails closed.
7. Server rejection: UI displays actionable subscription message.

## Screenshots Required

Capture or update screenshots for:

1. Local-only free onboarding with no cloud dead ends.
2. Settings provider selector for free user.
3. Upgrade CTA from provider/settings surface.
4. Account/sign-in entry point for cloud tier.
5. Billing management screen for subscribed user.
6. Provider selector for entitled user showing cloud transcription/cleanup.
7. Entitlement expired/lapsed state with local fallback message.
8. Privacy indicator/copy for local mode.
9. Privacy indicator/copy for cloud mode.

All screenshots must use fake accounts and fake billing data.

## Acceptance Criteria

1. Free users without an active subscription see a polished local-only experience with no selectable cloud AI providers and no broken cloud sync paths.
2. Cloud AI transcription and cleanup are available only to signed-in users with active cloud AI entitlement.
3. Account sync is available only to signed-in users with active cloud sync entitlement.
4. Supabase `transcribe` rejects missing auth with `401`.
5. Supabase `transcribe` rejects authenticated unentitled callers with `403`.
6. Supabase `cleanup` rejects missing auth with `401`.
7. Supabase `cleanup` rejects authenticated unentitled callers with `403`.
8. Server-side tests verify Azure is not called for rejected users.
9. Stripe webhook updates Supabase subscription and entitlement state for subscribe, renew, cancel, lapse, and trial expiry lifecycle events.
10. Subscription cancellation preserves access until the paid period ends.
11. Subscription lapse disables cloud AI and sync without deleting local or cloud user data.
12. Existing local provider flows continue working for all users.
13. Billing and entitlement architecture is documented.
14. Privacy copy accurately distinguishes local processing from cloud processing.
15. Screenshots cover free, subscribed, and lapsed states.

## Boundaries

### Always Do

- Keep local-only functionality free and available.
- Enforce entitlement server-side before Azure calls.
- Preserve user data across downgrade/lapse.
- Use fake data in screenshots/docs.
- Keep entitlement output minimal and redacted.
- Run targeted tests for entitlement, billing, provider selection, and Edge Function enforcement.

### Ask First

- Adding usage-based metering or hard usage caps.
- Choosing a billing provider other than Stripe.
- Requiring app-store billing.
- Changing Supabase auth provider.
- Introducing persistent storage of transcripts, audio, prompts, or cleanup output.
- Adding new paid tiers beyond free/pro.

### Never Do

- Expose Azure, Stripe, Supabase service-role, or webhook secrets to the client.
- Trust client-side entitlement state for paid inference.
- Deploy paid inference functions with anonymous access.
- Delete user data on subscription lapse.
- Store raw billing payloads or secrets in client caches.
- Show real customer PII in screenshots.

## Open Questions

1. Confirm billing provider: Stripe Checkout + Customer Portal?
2. Confirm tier model: free local-only and paid cloud+sync, or separate cloud AI/sync entitlements?
3. Are usage caps required for transcription minutes or cleanup tokens in v1?
4. Should trials be supported at launch?
5. What offline grace period, if any, should apply to previously entitled users?
6. Should lapsed cloud sync become read-only, paused entirely, or allow local-only editing with later reconciliation?
7. Should cloud provider preferences remain saved but inactive after downgrade?
8. What exact product and pricing IDs should Stripe use per environment?
```

