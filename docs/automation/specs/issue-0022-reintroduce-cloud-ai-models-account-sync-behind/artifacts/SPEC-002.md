<!-- verbatim-ai:artifact:v1 issue=22 phase=spec id=issue-0022-issue-0022-56a83768-22a2-4612-8a39-39fa0ee6d3a8-SPEC-002 display=SPEC-002 run=issue-0022-56a83768-22a2-4612-8a39-39fa0ee6d3a8 -->
# SPEC-002: Architect spec

- Issue: #22
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0022-issue-0022-56a83768-22a2-4612-8a39-39fa0ee6d3a8-SPEC-002
- Agent: architect
- Run: issue-0022-56a83768-22a2-4612-8a39-39fa0ee6d3a8
- Created: 2026-07-24T13:08:05.393Z

## Summary

Spec

## Body

# Spec

```markdown
# Spec: Issue 0022 — Reintroduce Cloud AI Models and Account Sync Behind Subscription Entitlements

## Assumptions

1. Billing will use **Stripe Checkout + Stripe Customer Portal** unless a maintainer chooses another provider before implementation.
2. Cloud features require a signed-in Supabase user account.
3. Supabase remains the source of truth for auth, synced account data, and entitlement state.
4. Local transcription/cleanup remains free and available without account creation.
5. Client-side gating is UX only; **Edge Functions must enforce entitlement server-side** before any Azure inference call.
6. Usage caps and trials are supported by the data model, but the initial paid tier can launch as a simple active/inactive subscription unless product decides otherwise.

## Objective

Reintroduce Verbatim AI cloud features after the local-only release from issue #21:

- Cloud transcription via Azure Whisper through Supabase Edge Functions.
- Cloud cleanup via Azure GPT through Supabase Edge Functions.
- Optional cloud account sync for modes, vocabulary, app mappings, and profile data.
- Billing-backed entitlement gating so paid inference and sync are only available to active subscribers.

Success means free users keep the same local-only experience, paid users can opt into cloud AI and sync, and unentitled calls are rejected server-side even if a client bypasses the UI.

## Current Repo Facts

Verbatim AI is a **Tauri 2 desktop app** with:

- React/TypeScript frontend in `src/`.
- Rust Tauri backend in `src-tauri/`.
- Supabase Edge Functions in `supabase/functions/`.
- Two Tauri windows:
  - `main` settings/management UI.
  - `overlay` transparent recording UI.
- Recording flow:
  1. Rust emits global hotkey events.
  2. `src/lib/hotkey.ts` and `src/lib/modeResolver.ts` resolve the active mode.
  3. `src/lib/recording-bridge.ts` starts overlay recording.
  4. `src/overlay/Overlay.tsx` captures audio.
  5. `src/lib/ai/index.ts` selects active provider.
  6. Rust `paste_to_target` pastes output.
- AI provider abstraction is defined in `src/lib/ai/AIProvider.ts`.
- Existing providers include:
  - `SupabaseAIProvider` for cloud transcription/cleanup.
  - `LocalWhisperProvider`.
  - `ParakeetProvider`.
  - `OllamaProvider` for local cleanup.
- App mode lives in `src/lib/appMode.ts` using localStorage key `sw.app.mode`.
- Auth and sync stores already exist:
  - `useAuth`
  - `useModes`
  - `useVocabulary`
  - `useAppMappings`
  - `useProfile`
  - `useRecording`
  - `useOnboarding`
- The current documented Supabase deployment commands use `--no-verify-jwt` for `transcribe` and `cleanup`; this must be changed or compensated for on the paid path.
- Issue #21 is expected to have hidden cloud UI behind `CLOUD_FEATURES_ENABLED` while preserving cloud code.

## Tech Stack

- Desktop shell: Tauri 2
- Frontend: React, TypeScript, Vite, Zustand
- Backend commands: Rust
- Cloud backend: Supabase Auth, Postgres, Row Level Security, Edge Functions
- Billing recommendation: Stripe Checkout, Stripe Billing Webhooks, Stripe Customer Portal
- AI backends:
  - Azure Whisper transcription
  - Azure GPT cleanup
  - Local Whisper / Parakeet / Ollama fallback paths

## Commands

```bash
pnpm install
pnpm lint
pnpm build
pnpm tauri dev
pnpm tauri build
supabase db push
supabase functions deploy transcribe
supabase functions deploy cleanup
supabase functions deploy stripe-webhook --no-verify-jwt
```

Notes:

- `stripe-webhook` must validate Stripe signatures itself and should remain unauthenticated at the Supabase gateway level.
- `transcribe` and `cleanup` should require authenticated user context for paid cloud access. Prefer deployment without `--no-verify-jwt` if compatible with the Supabase client flow.

## Project Structure

```text
src/
  App.tsx                         Main app routing and feature surfaces
  lib/
    ai/                           Provider abstraction and provider selection
    appMode.ts                    local/cloud app mode state
    entitlements.ts               New entitlement API/store integration
    store/                        Zustand stores and localStorage caches
  overlay/
    Overlay.tsx                   Recording and provider invocation UI
  components/
    Account/                      Account and billing entry surfaces
    Settings/                     Provider and sync settings
    Onboarding/                   Upgrade and migration entry points

src-tauri/
  src/commands/                   Native commands; should not enforce billing directly

supabase/
  migrations/                     Billing and entitlement schema
  functions/
    transcribe/                   Cloud transcription enforcement point
    cleanup/                      Cloud cleanup enforcement point
    stripe-webhook/               New Stripe event ingestion
    shared/                       Shared entitlement validation helpers

docs/
  automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md
```

## Architecture

### Subscription and Entitlement Model

Use Supabase Postgres as the application entitlement source of truth, synchronized from Stripe webhook events.

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
  stripe_subscription_id text unique not null,
  stripe_customer_id text not null,
  status text not null,
  price_id text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  grace_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

entitlements (
  user_id uuid primary key references auth.users(id),
  cloud_ai_enabled boolean not null default false,
  cloud_sync_enabled boolean not null default false,
  tier text not null default 'free',
  source text not null default 'stripe',
  valid_until timestamptz,
  last_verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  feature text not null,
  provider text not null,
  units numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
)
```

Initial entitlement rules:

| Stripe status | Entitlement |
|---|---|
| `trialing` | enabled until trial end |
| `active` | enabled until current period end |
| `past_due` | enabled only if inside configured grace period |
| `canceled` | disabled after period/grace expires |
| `unpaid` | disabled |
| missing subscription | disabled |

### Client Entitlement Flow

Add a client entitlement layer, likely a Zustand store/hook:

```ts
type EntitlementState = {
  status: 'unknown' | 'free' | 'trialing' | 'active' | 'grace' | 'expired';
  cloudAiEnabled: boolean;
  cloudSyncEnabled: boolean;
  tier: 'free' | 'pro';
  validUntil: string | null;
  refresh: () => Promise<void>;
};
```

Responsibilities:

- Hydrate from Supabase for signed-in users.
- Cache minimal entitlement state in localStorage for UI continuity only.
- Never treat localStorage as authority for cloud calls.
- Expose helpers such as:
  - `canUseCloudAi`
  - `canUseCloudSync`
  - `requiresUpgrade`
- Downgrade cloud provider selections to local-safe defaults when entitlement becomes inactive.

### Provider Selection

`getActiveProvider(mode?)` should preserve current composite-provider behavior, but entitlement-aware selection must happen before cloud providers are returned.

Rules:

1. If transcription provider is cloud and entitlement is active, use `SupabaseAIProvider`.
2. If transcription provider is cloud and entitlement is inactive, fall back to the configured local transcription default.
3. If cleanup provider is cloud and entitlement is active, use `SupabaseAIProvider`.
4. If cleanup provider is cloud and entitlement is inactive, fall back to local cleanup default or no cleanup depending on existing app behavior.
5. Per-mode overrides must follow the same rules as global settings.
6. Downgrade should be explicit in UI copy and non-destructive in stored preferences where possible, so a resubscribed user can restore cloud choices.

### UI Surfaces

Free users should see the same local-only UX introduced by issue #21.

Paid or trialing users should see:

- Cloud transcription/cleanup provider options in Settings.
- Cloud provider options in per-mode overrides.
- Account/sync settings.
- MigrationPicker for local-to-cloud sync migration.
- Account page with subscription status and “Manage billing”.
- Clear cloud/local privacy copy.

Upgrade entry points:

- Account screen.
- Disabled cloud provider option with “Upgrade to use cloud AI” if product wants visible upsells.
- Onboarding “Create account” or “Enable sync” path.
- Failure state from rejected cloud calls.

Avoid dead ends: if a user is signed out or unentitled, any cloud path must either explain the requirement or keep them in local mode.

### Billing Flow

Recommended Stripe flow:

1. Signed-in user clicks upgrade.
2. Client calls a Supabase Edge Function such as `create-checkout-session`.
3. Function verifies Supabase user JWT.
4. Function creates or reuses Stripe customer.
5. Function creates Stripe Checkout session.
6. Client opens checkout URL.
7. Stripe sends webhook to `stripe-webhook`.
8. Webhook validates Stripe signature.
9. Webhook upserts subscription and entitlement state.
10. Client refreshes entitlement after checkout return.

Customer portal:

1. Signed-in user clicks “Manage billing”.
2. Client calls `create-customer-portal-session`.
3. Function verifies user JWT and existing Stripe customer mapping.
4. Client opens portal URL.

### Server-Side Enforcement

`transcribe` and `cleanup` must enforce entitlement before proxying to Azure.

Required behavior:

1. Reject missing or invalid Supabase JWT.
2. Resolve authenticated `user_id`.
3. Query entitlement using server-side credentials or a security-definer RPC.
4. Reject if `cloud_ai_enabled` is false or entitlement is expired.
5. Only then call Azure.
6. Record usage event after successful cloud inference.
7. Return clear structured errors for:
   - unauthenticated
   - entitlement required
   - entitlement expired
   - usage limit exceeded, if caps are implemented
   - provider failure

Example response shape:

```ts
type CloudFeatureError =
  | { code: 'AUTH_REQUIRED'; message: string }
  | { code: 'ENTITLEMENT_REQUIRED'; message: string }
  | { code: 'ENTITLEMENT_EXPIRED'; message: string }
  | { code: 'USAGE_LIMIT_EXCEEDED'; message: string }
  | { code: 'PROVIDER_ERROR'; message: string };
```

### Account Sync

Cloud sync should require `cloudSyncEnabled`.

Rules:

- Local mode remains fully functional without account.
- Cloud sync requires signed-in user and active entitlement.
- If entitlement lapses:
  - Stop sync writes.
  - Keep local cached data.
  - Preserve remote data.
  - Show downgrade messaging.
  - Do not delete modes, vocabulary, app mappings, or profile data.
- Re-subscribing should resume sync without data loss.

## Code Style

Follow existing TypeScript patterns: explicit types, narrow guards, no broad silent fallbacks, and no entitlement decisions based solely on localStorage.

Example:

```ts
export function canUseCloudAi(entitlement: EntitlementState): boolean {
  return (
    entitlement.status === 'active' ||
    entitlement.status === 'trialing' ||
    entitlement.status === 'grace'
  ) && entitlement.cloudAiEnabled;
}

export function resolveCloudFallback(
  requestedProvider: AIProviderKind,
  entitlement: EntitlementState,
): AIProviderKind {
  if (requestedProvider !== 'supabase') return requestedProvider;
  return canUseCloudAi(entitlement) ? 'supabase' : 'local-whisper';
}
```

Conventions:

- Prefer reusable helpers over scattered entitlement checks.
- Keep provider selection deterministic.
- Do not use `as any` to bypass entitlement or provider typing.
- Do not swallow entitlement refresh or server rejection errors.
- Keep UI copy consistent: “cloud AI”, “local AI”, “account sync”, “subscription”.

## Security Requirements

### Must Enforce

- Azure credentials remain server-side only.
- Stripe secrets remain server-side only.
- Stripe webhook must verify `Stripe-Signature`.
- Entitlements must be derived from Stripe webhook/server data, never from client claims.
- Edge Functions must reject unentitled calls server-side.
- RLS must prevent users from reading or writing other users’ billing/subscription records.
- Local entitlement cache is UX-only and cannot authorize cloud inference.
- Usage events must avoid storing raw audio or transcript text unless explicitly required and documented.
- Cloud function logs must not include raw audio, transcripts, cleanup text, JWTs, Stripe secrets, or Azure credentials.
- Account sync must not overwrite or delete local data on subscription lapse.

### Threats to Address

| Threat | Mitigation |
|---|---|
| User bypasses hidden UI and calls Edge Function directly | JWT + server-side entitlement check |
| User tampers with localStorage entitlement | Server ignores local entitlement state |
| Forged billing webhook | Stripe signature verification |
| Cross-user billing record access | RLS and user-scoped queries |
| Paid inference abuse | Entitlement checks plus optional usage metering |
| Subscription lapse while app is open | Entitlement refresh and server rejection handling |
| Offline entitlement spoofing | No offline cloud calls; local-only fallback |
| Data loss on downgrade | Stop sync, preserve local and remote records |

## Privacy Requirements

The app must clearly communicate:

- Local providers process audio/text on-device.
- Cloud providers send audio/text to Supabase/Azure for transcription or cleanup.
- Account sync stores user configuration in Supabase.
- Subscription status and billing identifiers are stored for entitlement enforcement.
- Raw audio/transcript retention policy for Edge Functions, if any.

## Testing Strategy

### Unit Tests

Cover:

- Entitlement state mapping from subscription records.
- Provider fallback when entitlement is inactive.
- Provider restoration when entitlement becomes active again.
- UI gating helpers.
- Subscription status-to-entitlement rules.
- Grace period and trial handling.
- Downgrade behavior without deleting local data.

### Integration Tests

Cover:

- Signed-out user cannot access cloud AI.
- Signed-in but unsubscribed user cannot access cloud AI.
- Subscribed user can access cloud transcription.
- Subscribed user can access cloud cleanup.
- Lapsed subscription downgrades provider choices safely.
- Account sync is disabled when `cloudSyncEnabled` is false.
- Stripe webhook updates entitlement records idempotently.
- Duplicate webhook events do not corrupt subscription state.

### Edge Function Tests

Required server-side enforcement tests:

1. `transcribe` rejects missing JWT.
2. `transcribe` rejects valid JWT without entitlement.
3. `transcribe` allows valid JWT with active entitlement.
4. `cleanup` rejects missing JWT.
5. `cleanup` rejects valid JWT without entitlement.
6. `cleanup` allows valid JWT with active entitlement.
7. Stripe webhook rejects invalid signature.
8. Stripe webhook accepts valid subscription lifecycle events.

### Manual QA

Test these flows on macOS at minimum:

1. Fresh install, no account: local-only UX, no cloud dead ends.
2. Create account but no subscription: local-only UX plus upgrade entry.
3. Subscribe: cloud AI and sync become available.
4. Select cloud transcription and cleanup: recording succeeds.
5. Cancel subscription at period end: access remains until entitlement expiry.
6. Expire/lapse subscription: app downgrades to local without data loss.
7. Resubscribe: prior cloud preferences and sync resume where appropriate.
8. Server rejects entitlement mid-session: UI shows actionable downgrade/upgrade message.

## Screenshot Plan

Capture screenshots for implementation review and docs:

1. Free local-only settings screen.
2. Account screen showing free tier and upgrade CTA.
3. Stripe Checkout handoff or mocked checkout entry state.
4. Subscribed account screen with active plan and manage billing CTA.
5. Provider settings showing cloud transcription/cleanup options for entitled user.
6. Per-mode provider override showing cloud options for entitled user.
7. Account sync or MigrationPicker entry point.
8. Entitlement failure/downgrade message after server rejection.
9. Privacy copy distinguishing local vs cloud processing.

Screenshots should redact emails, names, billing IDs, customer IDs, and subscription IDs.

## Boundaries

### Always Do

- Preserve local-only free behavior.
- Enforce entitlement server-side.
- Keep Azure and Stripe secrets out of the client.
- Use Supabase Auth identity for entitlement lookup.
- Preserve user data on downgrade.
- Add tests for entitlement rejection and lifecycle transitions.
- Document billing setup and entitlement behavior.

### Ask First

- Changing billing provider away from Stripe.
- Adding app-store billing.
- Adding hard usage caps that block paid users.
- Persisting raw audio or transcript text server-side.
- Changing sync conflict-resolution semantics.
- Adding new paid tiers beyond free/pro.
- Changing CI or release packaging.

### Never Do

- Trust client localStorage for paid access.
- Expose Azure keys, Stripe keys, or service-role keys to the frontend.
- Deploy paid inference functions with only anon-key access and no user entitlement verification.
- Delete local data when a subscription lapses.
- Log raw user audio, transcripts, JWTs, or billing secrets.
- Hide server-side entitlement failures behind silent local fallback.

## Implementation Plan

### Phase 1 — Schema and Entitlement Foundation

- Add Supabase migrations for billing customer, subscription, entitlement, and usage tables.
- Add RLS policies.
- Add entitlement RPC/helper for Edge Functions.
- Add seed/test helpers for active, free, trialing, grace, and expired states.

Verification:

- Migration applies cleanly.
- RLS prevents cross-user reads.
- Entitlement helper returns expected active/inactive states.

### Phase 2 — Billing Integration

- Add Stripe checkout session Edge Function.
- Add Stripe customer portal Edge Function.
- Add Stripe webhook Edge Function.
- Implement idempotent subscription and entitlement updates.
- Document required Stripe environment variables and webhook events.

Verification:

- Valid webhook updates entitlement.
- Invalid webhook signature is rejected.
- Duplicate webhook is safe.

### Phase 3 — Server-Side Cloud Enforcement

- Update `transcribe` to require authenticated user and active cloud AI entitlement.
- Update `cleanup` to require authenticated user and active cloud AI entitlement.
- Add structured entitlement error responses.
- Add usage event recording after successful cloud calls.
- Update deployment docs to remove `--no-verify-jwt` from paid cloud functions if applicable.

Verification:

- Unauthenticated and unentitled function calls are rejected.
- Entitled calls still reach provider path.
- No raw audio/text is logged.

### Phase 4 — Client Entitlement Store

- Add entitlement Zustand store/hook.
- Hydrate entitlement after auth changes.
- Cache minimal non-authoritative entitlement summary.
- Add helper selectors for cloud AI and sync.
- Handle stale, expired, and refresh-failed states.

Verification:

- Free, active, trialing, grace, and expired states render correctly.
- Local cache cannot enable cloud calls without server entitlement.

### Phase 5 — Provider and Sync Gating

- Make provider selection entitlement-aware.
- Gate global provider settings.
- Gate per-mode provider overrides.
- Gate account sync reads/writes where required.
- Implement safe downgrade to local providers on lapse.

Verification:

- Free users cannot select cloud providers.
- Subscribed users can select cloud providers.
- Lapsed users fall back locally without data loss.

### Phase 6 — UI Restoration and Upgrade UX

- Restore Account/AuthGate/MigrationPicker paid-tier entry points.
- Add upgrade CTA and manage billing CTA.
- Add clear entitlement failure messages.
- Update local/cloud privacy copy.
- Ensure issue #21 local-only UX remains unchanged for free users.

Verification:

- Manual QA screenshots match expected states.
- No cloud dead ends for free users.
- Entitled users can complete cloud setup.

### Phase 7 — Documentation and Release Readiness

- Document Stripe setup.
- Document Supabase env vars and function deployment.
- Document entitlement lifecycle.
- Document downgrade behavior.
- Add troubleshooting notes for entitlement rejection.

Verification:

- Docs cover subscribe, renew, lapse, cancel, and resubscribe.
- Acceptance criteria are traceable to tests or manual QA.

## Acceptance Criteria

1. Users without an active subscription see the same local-only experience as issue #21.
2. Free users do not see usable cloud AI or sync controls, unless those controls are explicit upgrade CTAs.
3. Signed-out users cannot call cloud transcription or cleanup.
4. Signed-in but unentitled users cannot call cloud transcription or cleanup.
5. Entitled users can select and use cloud transcription.
6. Entitled users can select and use cloud cleanup.
7. Entitled users can enable account sync.
8. Edge Functions reject unentitled callers server-side with tests proving the rejection.
9. Stripe webhook updates entitlement state for subscribe, renew, lapse, cancel, and trial/grace transitions.
10. Subscription lapse downgrades the app to local providers without deleting local or remote user data.
11. Resubscription restores cloud access without requiring app reinstall or data reset.
12. Billing and entitlement setup are documented.
13. Privacy copy clearly distinguishes local processing from cloud processing.
14. Screenshots exist for free, upgrade, subscribed, cloud settings, sync, and failure states.

## Open Questions

1. Confirm Stripe as billing provider.
2. Confirm launch tier shape: one paid Pro tier or multiple tiers.
3. Confirm whether usage caps are required for launch.
4. Confirm trial duration and grace-period duration.
5. Confirm whether cloud sync is bundled with cloud AI or separately entitled.
6. Confirm whether upgrade CTAs should be visible to free users or cloud options should remain fully hidden.
7. Confirm exact privacy/retention policy for audio and transcript handling in Edge Functions.
```

