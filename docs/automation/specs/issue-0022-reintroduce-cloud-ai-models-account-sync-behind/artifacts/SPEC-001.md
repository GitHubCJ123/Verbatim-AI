<!-- verbatim-ai:artifact:v1 issue=22 phase=spec id=issue-0022-issue-0022-92836259-8519-477d-99ff-b79ed70d4be3-SPEC-001 display=SPEC-001 run=issue-0022-92836259-8519-477d-99ff-b79ed70d4be3 -->
# SPEC-001: Architect spec

- Issue: #22
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0022-issue-0022-92836259-8519-477d-99ff-b79ed70d4be3-SPEC-001
- Agent: architect
- Run: issue-0022-92836259-8519-477d-99ff-b79ed70d4be3
- Created: 2026-07-24T09:03:05.727Z

## Summary

Spec

## Body

# Spec

Proposed content for `docs/automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md`:

```markdown
# Spec: Issue 0022 - Reintroduce Cloud AI Models and Account Sync Behind Subscription

## Objective

Reintroduce Verbatim AI cloud features as a paid tier while preserving the local-only free experience.

Cloud features include:

- Azure Whisper transcription through Supabase Edge Function `transcribe`
- Azure GPT cleanup through Supabase Edge Function `cleanup`
- Optional authenticated account sync for modes, vocabulary, profile, and app mappings

Success means local users continue seeing a complete local-only product with no dead cloud surfaces, while subscribed users can sign in, manage billing, enable cloud providers, sync data, and use cloud inference. Entitlement must be enforced both in the client and on the server.

## Assumptions

1. Stripe Checkout + Stripe Customer Portal is the first billing provider because Verbatim AI is a desktop Tauri app and not distributed through app-store billing yet.
2. Supabase remains the source of truth for auth, account data, sync data, entitlement records, and Edge Functions.
3. Cloud inference requires a signed-in Supabase user and an active entitlement.
4. Free/local mode does not require an account.
5. The paid tier grants both cloud AI and account sync unless later product decisions split them.
6. Usage caps are supported in the data model, but initial launch can use a simple active/inactive entitlement unless pricing requires metering.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with a React/TypeScript frontend and Rust backend.

Relevant existing architecture:

- `src/lib/appMode.ts`
  - Stores app mode in localStorage under `sw.app.mode`.
  - Supports `"local"` and `"cloud"` modes.

- `src/lib/ai/index.ts`
  - Exposes `getActiveProvider(mode?)`.
  - Composes transcription and cleanup providers independently.

- Existing AI providers:
  - `SupabaseAIProvider` for cloud transcription/cleanup through Supabase Edge Functions.
  - `LocalWhisperProvider` for local Whisper sidecar transcription.
  - `ParakeetProvider` for local Parakeet/sherpa-onnx transcription.
  - `OllamaProvider` for local cleanup.

- Existing auth/sync surfaces:
  - `useAuth`
  - `Account`
  - `AuthGate`
  - `MigrationPicker`
  - Supabase-backed stores for modes, vocabulary, profile, app mappings.

- Overlay recording pipeline:
  - Hotkey event starts recording.
  - `src/overlay/Overlay.tsx` captures audio.
  - `getActiveProvider(mode?)` selects transcribe/cleanup providers.
  - Result is pasted through Rust command `paste_to_target`.

- Supabase Edge Functions:
  - `supabase/functions/transcribe`
  - `supabase/functions/cleanup`
  - Current project guidance says functions are deployed with `--no-verify-jwt`.
  - Paid cloud inference must not rely on anon-key access.

- Issue #21 context:
  - Cloud surfaces are hidden behind `CLOUD_FEATURES_ENABLED`.
  - Cloud code remains intact.

## Tech Stack

- Desktop shell: Tauri 2
- Frontend: React + TypeScript + Vite
- State: Zustand + localStorage cache
- Backend shell: Rust Tauri commands
- Auth/database/functions: Supabase
- Billing: Stripe Checkout, Stripe Customer Portal, Stripe webhooks
- Cloud AI: Azure Whisper transcription and Azure GPT cleanup proxied through Supabase Edge Functions

## Commands

Developer commands expected for implementation validation:

```bash
pnpm install
pnpm lint
pnpm build
pnpm tauri dev
supabase db push
supabase functions deploy transcribe
supabase functions deploy cleanup
```

If billing/webhook functions are added:

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

`stripe-webhook` should remain unauthenticated at the Supabase JWT layer because Stripe cannot send Supabase JWTs, but it must verify the Stripe webhook signature before doing any work.

## Product Model

### Free Tier

Free users get:

- Local transcription providers only.
- Local cleanup providers only.
- LocalStorage-backed modes, vocabulary, app mappings, profile.
- No account requirement.
- No cloud AI provider options.
- No account sync surfaces unless presented as upgrade/sign-in entry points.

Free users must not encounter broken cloud provider options or server rejection during normal local use.

### Paid Tier

Subscribed users get:

- Account sign-in.
- Cloud transcription provider option.
- Cloud cleanup provider option.
- Account sync.
- Billing management through Stripe Customer Portal.
- Graceful downgrade if subscription lapses.

### Subscription Lifecycle

Supported states:

| State | Meaning | Client Behavior | Server Behavior |
|---|---|---|---|
| `none` | No subscription | Local-only | Reject cloud inference |
| `trialing` | Trial active | Cloud enabled | Allow cloud inference |
| `active` | Paid subscription active | Cloud enabled | Allow cloud inference |
| `past_due` | Payment failed, grace allowed | Cloud enabled only during grace window | Allow until grace expires |
| `canceled` | Canceled but period may remain | Cloud enabled until `current_period_end` | Allow until period end |
| `expired` | No active access | Downgrade to local | Reject cloud inference |

## Architecture

### Entitlement Source of Truth

Add Supabase-backed entitlement records derived only from trusted billing events.

Recommended tables:

```sql
billing_customers (
  user_id uuid primary key references auth.users(id),
  stripe_customer_id text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  stripe_customer_id text not null,
  stripe_subscription_id text unique not null,
  status text not null,
  price_id text,
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
  account_sync_enabled boolean not null default false,
  entitlement_status text not null,
  valid_until timestamptz,
  grace_until timestamptz,
  source text not null default 'stripe',
  updated_at timestamptz not null default now()
)

billing_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text
)
```

Optional future usage tables:

```sql
cloud_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  function_name text not null,
  provider text not null,
  units integer not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
)
```

### Billing Flow

1. User selects upgrade from Account, Settings, onboarding, or provider picker.
2. Client calls a Supabase function such as `create-checkout-session`.
3. Function requires a valid Supabase user JWT.
4. Function creates or reuses a Stripe customer linked to `auth.users.id`.
5. Function returns Stripe Checkout URL.
6. Desktop app opens the URL in the system browser.
7. Stripe redirects to a success/cancel URL.
8. Stripe webhook updates `subscriptions` and `entitlements`.
9. Client refreshes entitlement state after return and periodically while signed in.

### Customer Portal Flow

1. Signed-in user opens Account billing management.
2. Client calls `create-customer-portal-session`.
3. Function requires valid Supabase user JWT.
4. Function verifies the Stripe customer belongs to the authenticated user.
5. Function returns portal URL.
6. Desktop app opens URL in browser.

### Client Entitlement State

Add a client store/hook, for example:

- `src/lib/store/entitlements.ts`
- `useEntitlements`
- `hydrateEntitlements`
- `refreshEntitlements`

Responsibilities:

- Track loading/error/status.
- Expose booleans:
  - `canUseCloudAI`
  - `canUseAccountSync`
  - `isInGracePeriod`
  - `requiresUpgrade`
- Cache safe entitlement summary in localStorage for overlay access.
- Never cache secrets, Stripe IDs, raw webhook data, tokens, or complete subscription payloads.
- Treat cached entitlement only as UX state, not authorization.

Example shape:

```ts
type EntitlementStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'expired';

interface EntitlementSnapshot {
  status: EntitlementStatus;
  cloudAiEnabled: boolean;
  accountSyncEnabled: boolean;
  validUntil: string | null;
  graceUntil: string | null;
  fetchedAt: string;
}
```

### Replacing `CLOUD_FEATURES_ENABLED`

`CLOUD_FEATURES_ENABLED` should stop acting as a global hard-coded product state.

Recommended replacement:

- Keep a build/config flag only as a kill switch, e.g. `CLOUD_FEATURES_BUILD_ENABLED`.
- Add runtime entitlement checks for actual access.
- Cloud UI visibility should require both:
  - cloud build flag enabled
  - signed-in user with active entitlement

Example policy:

```ts
const canShowCloudProviders =
  CLOUD_FEATURES_BUILD_ENABLED && entitlement.cloudAiEnabled;

const canUseCloudProvider =
  CLOUD_FEATURES_BUILD_ENABLED &&
  auth.user !== null &&
  entitlement.cloudAiEnabled;
```

### Provider Selection

Provider selection must be guarded at every layer:

1. Settings UI only shows cloud providers when entitled.
2. Per-mode overrides only show cloud providers when entitled.
3. `getActiveProvider(mode?)` must not return `SupabaseAIProvider` for unentitled users.
4. Overlay should fallback to local defaults if cached provider config references cloud but entitlement is absent.
5. Edge Functions must reject calls without entitlement.

Fallback behavior:

- If subscription lapses and selected provider was cloud transcription:
  - fallback to preferred local transcription provider.
- If subscription lapses and selected provider was cloud cleanup:
  - fallback to local cleanup provider if configured, otherwise no cleanup or existing local default.
- User data remains intact.
- Cloud selections may remain stored but inactive, so access can resume after renewal without losing preferences.

### Account Sync

Account sync is part of the paid tier.

Behavior:

- Local users continue using localStorage-backed data.
- Paid signed-in users can migrate local data to cloud using existing `MigrationPicker`.
- If paid access lapses:
  - Keep local cached data.
  - Stop cloud sync writes.
  - Continue local mode without destructive data deletion.
  - Display clear downgrade messaging.
- If user renews:
  - Resume cloud sync.
  - Reconcile local changes using existing store hydration/sync patterns.

### Edge Function Enforcement

`transcribe` and `cleanup` must require authenticated users for paid cloud inference.

Recommended behavior:

1. Read `Authorization: Bearer <jwt>`.
2. Verify JWT through Supabase Auth.
3. Resolve `user_id`.
4. Query `entitlements`.
5. Confirm `cloud_ai_enabled = true` and current time is before `valid_until` or `grace_until`.
6. Reject otherwise with `403`.
7. Only then call Azure.
8. Record usage event if metering/audit logging is enabled.

Error categories:

| Condition | Status |
|---|---|
| Missing bearer token | `401` |
| Invalid/expired token | `401` |
| No entitlement | `403` |
| Expired entitlement | `403` |
| Azure failure | existing upstream error behavior |
| Invalid request payload | `400` |

The anon key must not be sufficient to access Azure-backed inference.

## Security Requirements

- Never trust client entitlement state for authorization.
- Never expose Azure keys to the client.
- Never expose Stripe secret keys to the client.
- Verify Stripe webhook signatures before parsing or processing events.
- Make webhook processing idempotent using Stripe event ID.
- Use service-role Supabase access only inside server-side functions.
- Do not persist raw webhook payloads unless explicitly required and scrubbed.
- Do not log bearer tokens, Stripe secrets, Azure secrets, audio payloads, transcript contents, or cleanup text.
- Entitlement updates must be derived from Stripe webhook events or trusted admin/server paths only.
- Client-side localStorage entitlement cache is display-only and must not unlock server access.
- RLS should prevent users from reading other users' billing, subscription, entitlement, or usage data.
- Checkout and portal session creation must verify the authenticated user owns the Stripe customer.
- Server-side entitlement checks should be centralized to avoid inconsistent enforcement between `transcribe` and `cleanup`.

## UX Requirements

### Local Free User

- Sees local-only provider options.
- Does not see selectable cloud AI providers.
- Does not see account sync as already available.
- May see upgrade entry points where appropriate.
- Can complete onboarding without account creation.
- Can record, transcribe, clean up, and paste using local providers.

### Subscribed User

- Can sign in.
- Can enable account sync.
- Can select cloud transcription and cleanup globally.
- Can select cloud transcription and cleanup in per-mode overrides.
- Sees billing status and manage-subscription action in Account.
- Gets clear copy that cloud processing sends audio/text to cloud services.

### Lapsed User

- Sees cloud providers disabled with renewal messaging.
- Existing local data remains available.
- App automatically falls back to local providers.
- Cloud sync stops without deleting cloud or local data.
- Account page shows billing state and renewal/manage link.

### Failure UX

If server rejects cloud inference because entitlement is missing or expired:

- Show a concise entitlement error.
- Offer upgrade/manage billing action.
- Do not discard the recording if a local fallback can be attempted safely.
- Do not loop retry cloud calls.

## Privacy Copy

When both local and cloud are available, provider UI must clearly distinguish:

- Local transcription/cleanup:
  - Runs on device.
  - No audio/text sent to Verbatim cloud for AI processing.

- Cloud transcription/cleanup:
  - Sends audio/text to Verbatim AI cloud infrastructure and Azure-backed providers.
  - Requires account and active subscription.

Overlay/privacy indicator copy should reflect the active provider, not merely the app mode.

## Testing Strategy

### Unit Tests

Cover:

- Entitlement state derivation.
- Provider visibility rules.
- Provider fallback when entitlement lapses.
- `getActiveProvider(mode?)` guard behavior.
- Subscription status mapping to entitlement booleans.
- LocalStorage entitlement snapshot sanitization.
- Upgrade/renewal UI state helpers.

### Integration Tests

Cover:

- Signed-out user cannot select cloud provider.
- Signed-in but unentitled user cannot select cloud provider.
- Entitled user can select cloud transcription and cleanup.
- Lapsed entitlement downgrades provider selection to local without deleting preferences.
- Existing local-only #21 behavior remains unchanged for unentitled users.

### Supabase Function Tests

Cover:

- `transcribe` rejects missing bearer token.
- `transcribe` rejects invalid JWT.
- `transcribe` rejects valid JWT without entitlement.
- `transcribe` allows active entitlement.
- `cleanup` rejects missing bearer token.
- `cleanup` rejects valid JWT without entitlement.
- `cleanup` allows active entitlement.
- Stripe webhook rejects invalid signature.
- Stripe webhook is idempotent.
- Stripe webhook updates entitlement for trial, active, canceled, expired, and past-due states.

### Manual QA

Scenarios:

1. Fresh install, no account, local-only onboarding.
2. Existing local user upgrades and migrates data.
3. Existing cloud-capable settings are hidden for unentitled user.
4. Subscribed user selects cloud transcription and cleanup.
5. Subscription cancellation leaves access until period end.
6. Subscription expiry downgrades to local without data loss.
7. Server-side cloud call with anon key only is rejected.
8. Server-side cloud call with valid JWT but no entitlement is rejected.
9. Billing portal opens for subscribed user.
10. Privacy copy changes based on active local/cloud provider.

## Screenshot Requirements

Capture screenshots for the implementation PR or release note:

1. Local-only Settings provider section for an unentitled user.
2. Upgrade entry point from Settings or Account.
3. Account page showing active subscription.
4. Cloud provider options visible for an entitled user.
5. Per-mode cloud override visible for an entitled user.
6. Lapsed subscription state with disabled cloud options.
7. Privacy indicator/copy for local processing.
8. Privacy indicator/copy for cloud processing.
9. Server rejection/error UX for entitlement failure, if surfaced in UI.

Screenshots must not contain personal data, real emails, real names, billing identifiers, Stripe customer IDs, tokens, transcripts, or audio-derived content.

## Project Structure

Expected implementation areas:

```text
src/lib/appMode.ts
  Existing local/cloud mode state.

src/lib/ai/
  Provider selection and Supabase provider guards.

src/lib/store/
  Existing Zustand stores plus new entitlement store.

src/components/ or src/pages/
  Settings, Account, onboarding, provider picker, migration surfaces.

src/overlay/
  Overlay provider behavior and privacy/status copy.

supabase/functions/transcribe/
  Cloud transcription entitlement enforcement.

supabase/functions/cleanup/
  Cloud cleanup entitlement enforcement.

supabase/functions/create-checkout-session/
  Stripe Checkout session creation.

supabase/functions/create-customer-portal-session/
  Stripe portal session creation.

supabase/functions/stripe-webhook/
  Stripe webhook verification and entitlement persistence.

supabase/migrations/
  Billing, subscription, entitlement, usage schema.

docs/
  Billing and entitlement documentation.
```

## Code Style

Use existing TypeScript conventions, typed state, and explicit guards.

Example entitlement guard style:

```ts
export function canUseCloudAI(
  authUserId: string | null,
  entitlement: EntitlementSnapshot | null,
): boolean {
  if (!authUserId || !entitlement) {
    return false;
  }

  return entitlement.cloudAiEnabled && isEntitlementCurrentlyValid(entitlement);
}
```

Avoid:

- broad `catch` blocks that hide entitlement failures
- `as any`
- client-only authorization checks
- storing raw provider secrets or billing payloads in localStorage
- duplicating entitlement logic across many UI components

## Boundaries

### Always Do

- Preserve local-only behavior for free users.
- Enforce entitlement server-side before Azure calls.
- Keep cloud fallback non-destructive.
- Verify Stripe webhook signatures.
- Use RLS and authenticated user ownership checks.
- Add tests for entitlement rejection.
- Keep provider/privacy copy accurate.

### Ask First

- Adding metered billing.
- Adding app-store billing.
- Splitting cloud AI and account sync into separate paid tiers.
- Changing pricing model.
- Deleting or migrating existing user cloud data.
- Adding a new analytics or telemetry vendor.
- Changing CI/deployment workflows.

### Never Do

- Expose paid Azure inference through anon-key-only calls.
- Trust localStorage entitlement for authorization.
- Commit Stripe, Azure, or Supabase service-role secrets.
- Log audio, transcripts, cleanup text, JWTs, billing payloads, or API keys.
- Delete local user data on downgrade.
- Show cloud provider options as usable when the server will reject them.

## Implementation Plan

### Phase 1 - Data Model and Entitlement Contract

- Add billing/subscription/entitlement schema.
- Add RLS policies.
- Define entitlement snapshot shape returned to the client.
- Add tests for entitlement derivation.

### Phase 2 - Billing Functions

- Add checkout session function.
- Add customer portal function.
- Add Stripe webhook function.
- Implement idempotent event processing.
- Update entitlement records from subscription lifecycle events.

### Phase 3 - Server-Side AI Enforcement

- Update `transcribe` to require JWT and active entitlement.
- Update `cleanup` to require JWT and active entitlement.
- Share entitlement verification helper between functions.
- Add rejection tests.

### Phase 4 - Client Entitlement Store

- Add entitlement store/hook.
- Hydrate entitlement on sign-in and app boot.
- Cache sanitized entitlement snapshot for overlay.
- Add provider fallback helpers.

### Phase 5 - UI Reintroduction

- Reintroduce Account/AuthGate/MigrationPicker as paid-tier entry points.
- Show cloud provider options only when entitled.
- Add upgrade/manage billing actions.
- Add lapsed subscription messaging.
- Update privacy copy.

### Phase 6 - End-to-End Validation and Docs

- Validate free, trial, active, canceled, expired flows.
- Capture screenshots.
- Document billing setup, environment variables, webhook setup, entitlement behavior, and deployment commands.

## Acceptance Criteria

1. Unentitled users see the same local-only experience as the post-#21 app.
2. Unentitled users cannot select cloud transcription or cloud cleanup from Settings, onboarding, or per-mode overrides.
3. Signed-in subscribed users can select cloud transcription and cloud cleanup.
4. Signed-in subscribed users can enable account sync.
5. `transcribe` rejects anon-key-only calls.
6. `cleanup` rejects anon-key-only calls.
7. `transcribe` rejects authenticated but unentitled users.
8. `cleanup` rejects authenticated but unentitled users.
9. Active or trialing entitlement allows cloud inference.
10. Subscription lapse disables cloud features in the UI.
11. Subscription lapse causes automatic local fallback without deleting local or cloud data.
12. Stripe webhook processing is signature-verified and idempotent.
13. Billing portal is available to users with a Stripe customer.
14. Privacy copy accurately distinguishes local and cloud processing.
15. Billing and entitlement setup are documented.
16. Screenshots are captured for free, entitled, and lapsed states.

## Open Product Decisions

These decisions should be resolved before implementation or explicitly deferred:

1. Final billing provider confirmation: Stripe vs. RevenueCat vs. app-store billing.
2. Whether paid tier is one bundle or separate cloud AI/account sync tiers.
3. Whether launch includes usage caps or unlimited fair-use subscription.
4. Trial duration and grace-period duration.
5. Whether cloud inference should be disabled immediately on `past_due` or after a grace window.
6. Whether team/family subscriptions are in scope.
7. Whether account sync should require paid subscription or be free with account creation.
```

