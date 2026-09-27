# Spec

Proposed content for `docs/automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md`:

```markdown
# Spec: Reintroduce Cloud AI Models + Account Sync Behind Subscription Entitlements

## Problem

Verbatim AI currently preserves cloud-related code paths but is expected to ship a local-only experience after issue #21. This feature reintroduces cloud transcription, cloud cleanup, and account sync only for users with an active paid entitlement.

The core problem is preventing unpaid access to paid inference and sync infrastructure while preserving a clean free local-only experience.

## Assumptions

1. Stripe Checkout + Stripe Customer Portal is the preferred billing path for the desktop app.
2. Supabase remains the identity, sync, entitlement, and Edge Function platform.
3. Cloud AI access requires a signed-in Supabase user.
4. Local transcription and local cleanup remain free and usable without an account.
5. Server-side entitlement checks are mandatory; client-side gating is UX only.
6. Entitlement state should be cached client-side only for UI responsiveness, not trusted for paid inference authorization.

## Current Repo Facts

- The app is a Tauri 2 desktop app with a React/TypeScript frontend and Rust backend.
- The frontend lives in `src/`; the Tauri backend lives in `src-tauri/`.
- The app has two windows:
  - `main`: settings and management UI.
  - `overlay`: floating recording UI.
- AI providers are defined through `src/lib/ai/AIProvider.ts`.
- Existing provider implementations include:
  - `SupabaseAIProvider` for cloud transcription and cleanup through Supabase Edge Functions.
  - `LocalWhisperProvider` for local Whisper transcription.
  - `ParakeetProvider` for local Sherpa/Parakeet transcription.
  - `OllamaProvider` for local cleanup.
- `getActiveProvider(mode?)` composes transcription and cleanup providers from global settings and per-mode overrides.
- App mode is stored in `src/lib/appMode.ts` using localStorage key `sw.app.mode`, currently either `local` or `cloud`.
- Stores use Zustand under `src/lib/store/` and write localStorage cache keys prefixed with `sw.` so the overlay can read synchronously.
- Cloud-related preserved surfaces include `SupabaseAIProvider`, `useAuth`, `Account`, `AuthGate`, `MigrationPicker`, and Supabase Edge Functions.
- Existing Supabase Edge Functions include `supabase/functions/transcribe` and `supabase/functions/cleanup`.
- Current deployment notes mention these functions may be deployed with `--no-verify-jwt`; the paid path must revisit this.

## Objective

Re-enable cloud AI models and optional account sync for subscribed users while preserving the local-only free tier.

Success means:

- Free users see a complete local-only product with no broken cloud affordances.
- Paid users can sign in, manage billing, sync account data, and select cloud AI providers.
- Supabase Edge Functions reject unentitled callers even if the UI is bypassed.
- Subscription lifecycle changes are reflected safely in the app.
- Lapsed users are downgraded to local providers without losing local data.

## Tech Stack

- Desktop shell: Tauri 2
- Frontend: React, TypeScript, Vite
- State: Zustand
- Backend commands: Rust Tauri commands under `src-tauri/src/commands/`
- Auth/sync/functions: Supabase
- Billing: Stripe Checkout, Stripe Billing, Stripe Customer Portal, Stripe webhooks
- Cloud inference: Azure Whisper transcription and Azure GPT cleanup through Supabase Edge Functions

## Commands

Expected validation commands:

```bash
pnpm lint
pnpm build
supabase functions serve transcribe
supabase functions serve cleanup
supabase functions deploy transcribe
supabase functions deploy cleanup
```

If Supabase function tests exist or are added, run the targeted function test command documented by the implementation PR.

## Proposed Architecture

### Entitlement Model

Add Supabase-backed entitlement records derived from Stripe webhook events.

Recommended tables:

- `billing_customers`
  - `user_id`
  - `stripe_customer_id`
  - timestamps

- `subscriptions`
  - `user_id`
  - `stripe_subscription_id`
  - `stripe_customer_id`
  - `status`
  - `current_period_end`
  - `cancel_at_period_end`
  - timestamps

- `entitlements`
  - `user_id`
  - `tier`
  - `cloud_ai_enabled`
  - `sync_enabled`
  - `valid_until`
  - `source`
  - timestamps

Entitlements are updated only by trusted server-side webhook handling, not by the client.

### Billing Flow

1. User chooses an upgrade action from Account, onboarding, or a cloud-disabled setting.
2. Client calls a Supabase function to create a Stripe Checkout session.
3. Stripe redirects to hosted Checkout.
4. Stripe webhook updates subscription and entitlement tables.
5. App refreshes entitlement state after redirect and periodically while signed in.
6. User can open Stripe Customer Portal from Account settings.

### Client Entitlement Store

Add a client entitlement store/hook, for example:

- `src/lib/store/entitlements.ts`
- `useEntitlements`
- `hydrateEntitlements`
- `refreshEntitlements`

The store should expose:

```ts
type EntitlementTier = 'free' | 'paid';

interface EntitlementState {
  tier: EntitlementTier;
  cloudAiEnabled: boolean;
  syncEnabled: boolean;
  status: 'unknown' | 'free' | 'active' | 'past_due' | 'canceled' | 'expired';
  validUntil?: string;
  isLoading: boolean;
}
```

Client-side entitlement checks determine what the UI offers, but not whether Edge Functions execute paid inference.

### Provider Selection

Cloud providers should be available only when all are true:

1. Cloud features are enabled by the app build/runtime flag.
2. User is signed in.
3. User has active entitlement.
4. The relevant feature is enabled:
   - `cloudAiEnabled` for cloud transcription/cleanup.
   - `syncEnabled` for account sync.

If entitlement lapses and a user previously selected cloud providers, the app should automatically resolve to local-safe providers and display a clear downgrade notice in settings.

### Edge Function Enforcement

`transcribe` and `cleanup` must verify:

1. A valid Supabase JWT is present.
2. The JWT resolves to a user.
3. The user has an active entitlement allowing cloud AI.
4. Optional usage caps have not been exceeded if caps are implemented.

The anon key alone must never authorize Azure proxying.

Recommended server behavior:

- `401` for missing/invalid auth.
- `403` for authenticated but unentitled users.
- `429` for exceeded usage caps if implemented.
- Clear structured JSON error responses.
- No Azure request should be made until entitlement passes.

### Account Sync

Account sync should be available only when `syncEnabled` is true.

Free users should remain local-only. Upgrade entry points may explain that sync requires a paid account, but they must not create dead ends or expose unusable sync screens.

### Failure UX

Required UX states:

- Free user viewing AI settings: only local providers are selectable.
- Free user encountering cloud provider copy: sees upgrade CTA, not disabled dead controls.
- Paid user: cloud providers and sync surfaces are available.
- Lapsed user: selected cloud options downgrade to local defaults with an explanation.
- Server rejection: app shows entitlement/billing message, not a generic transcription failure.
- Offline paid user: local providers remain usable; cloud calls cannot proceed without network/auth.

## Security Requirements

- Edge Functions must not trust client entitlement state.
- Stripe webhook signature verification is mandatory.
- Webhook handlers must be idempotent.
- No Stripe secrets, Azure keys, Supabase service role keys, or entitlement signing secrets may be exposed to the frontend.
- Entitlement reads should use RLS or trusted functions scoped to the current user.
- Billing customer IDs and subscription records must not be readable across users.
- Logs must not contain transcript audio, full transcript text, payment secrets, JWTs, or raw provider responses containing sensitive content.
- Downgrade behavior must not delete local user data.
- Any local entitlement cache must be treated as display-only.
- Supabase functions should reject malformed input before calling Azure.
- Cloud account/sync UI must not leak whether another email or user has a subscription.

## Testing Strategy

### Unit Tests

Cover:

- Entitlement store state transitions.
- Provider visibility rules.
- Provider fallback when entitlement is inactive.
- App mode and cloud feature gating.
- Billing status mapping from subscription states.
- Error mapping from `401`, `403`, and `429` Edge Function responses.

### Integration Tests

Cover:

- Signed-out user cannot select cloud providers.
- Signed-in unentitled user cannot select cloud providers.
- Entitled user can select cloud transcription and cleanup.
- Lapsed entitlement downgrades selected cloud providers to local providers.
- Account sync surfaces appear only when `syncEnabled` is true.
- Edge Function rejects missing JWT.
- Edge Function rejects valid JWT without entitlement.
- Edge Function allows valid JWT with active entitlement.
- Stripe webhook creates/updates entitlement records idempotently.

### Manual QA

Run through:

1. Fresh install, no account: local-only experience.
2. Sign up without subscription: local-only with upgrade CTA.
3. Complete subscription: cloud options appear.
4. Select cloud transcription and cleanup: recording succeeds.
5. Cancel subscription at period end: access remains until entitlement expiry.
6. Expire/lapse subscription: app downgrades to local.
7. Try direct Edge Function call without entitlement: rejected.
8. Open customer portal from Account settings.

## Screenshot Requirements

Capture screenshots for the implementation PR:

1. Free local-only AI settings with no cloud provider dead ends.
2. Upgrade CTA from Account or settings.
3. Paid account showing cloud provider options.
4. Cloud transcription/cleanup selected in settings.
5. Lapsed subscription downgrade notice.
6. Server-side entitlement rejection surfaced in the UI.
7. Customer portal entry point.

Screenshots should redact any email addresses, names, customer IDs, subscription IDs, or billing details.

## Boundaries

### Always Do

- Enforce entitlement server-side before Azure calls.
- Keep local-only mode fully functional without account or subscription.
- Preserve existing local user data during upgrade and downgrade.
- Use typed provider/entitlement states instead of loose booleans where possible.
- Add tests for entitlement rejection and downgrade behavior.
- Document billing setup and entitlement lifecycle.

### Ask First

- Adding usage-based billing or metering beyond simple subscription entitlement.
- Adding a new billing provider besides Stripe.
- Changing the Supabase auth model.
- Requiring account creation for local-only users.
- Changing subscription tier names or pricing.
- Changing CI, release signing, or deployment infrastructure.

### Never Do

- Trust client-side entitlement for paid inference.
- Ship Edge Functions that proxy Azure using only the anon key.
- Commit billing, Azure, or Supabase secrets.
- Log audio, transcript content, JWTs, Stripe secrets, or payment details.
- Delete user data when a subscription lapses.
- Expose cloud options to free users as broken controls.

## Acceptance Criteria

1. Users without an active subscription see the same local-only experience expected after issue #21.
2. Unsubscribed users do not see selectable cloud transcription, cloud cleanup, or sync controls.
3. Subscribed users can select and use cloud transcription and cleanup.
4. Subscribed users can use account sync.
5. `transcribe` rejects missing, invalid, or unentitled callers before Azure is invoked.
6. `cleanup` rejects missing, invalid, or unentitled callers before Azure is invoked.
7. Subscription lifecycle events update entitlements:
   - subscribe grants access;
   - renewal preserves access;
   - cancel-at-period-end preserves access until expiry;
   - lapse or cancellation removes access;
   - re-subscribe restores access.
8. If entitlement is removed, cloud provider selections downgrade to local-safe defaults without data loss.
9. Billing setup, webhook configuration, entitlement tables, and deployment steps are documented.
10. Tests cover client gating, server enforcement, and lifecycle downgrade behavior.

## Open Questions

1. Confirm Stripe as the billing provider.
2. Confirm subscription tiers and names.
3. Confirm whether usage caps are required for transcription minutes or cleanup tokens.
4. Confirm whether a trial period is included.
5. Confirm grace-period behavior for `past_due` subscriptions.
6. Confirm whether cloud sync and cloud AI are always bundled or can be separately entitled.
7. Confirm whether Edge Functions should switch fully to JWT verification or use custom verification inside the function for mixed free/paid paths.
```
