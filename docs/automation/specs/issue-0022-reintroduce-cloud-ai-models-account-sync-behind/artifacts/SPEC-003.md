<!-- verbatim-ai:artifact:v1 issue=22 phase=spec id=issue-0022-issue-0022-5b592166-ab44-4dcb-8ef8-ad8bb7f610a3-SPEC-003 display=SPEC-003 run=issue-0022-5b592166-ab44-4dcb-8ef8-ad8bb7f610a3 -->
# SPEC-003: Architect spec

- Issue: #22
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0022-issue-0022-5b592166-ab44-4dcb-8ef8-ad8bb7f610a3-SPEC-003
- Agent: architect
- Run: issue-0022-5b592166-ab44-4dcb-8ef8-ad8bb7f610a3
- Created: 2026-07-24T17:13:15.041Z

## Summary

Spec

## Body

# Spec

Proposed content for `docs/automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md`:

```markdown
# Spec: Reintroduce Cloud AI Models + Account Sync Behind Subscription Entitlements

## Assumptions

1. Verbatim AI remains a Tauri 2 desktop app with React/TypeScript frontend and Rust backend.
2. Local transcription/cleanup remains free and available without an account.
3. Cloud AI and cloud sync require a signed-in account plus an active entitlement.
4. Stripe Checkout + Stripe Customer Portal is the preferred billing path unless a maintainer selects another provider before implementation.
5. Supabase remains the account, sync, Edge Function, and entitlement persistence backend.
6. Edge Functions must enforce entitlement server-side before proxying paid Azure inference.

## Objective

Reintroduce Verbatim AI cloud capabilities as a paid tier without regressing the local-only experience.

Cloud features include:

- Azure Whisper transcription through the Supabase `transcribe` Edge Function.
- Azure GPT cleanup through the Supabase `cleanup` Edge Function.
- Optional cloud account sync for modes, vocabulary, mappings, and profile-backed settings.

Success means free users see a clean local-only app, while subscribed users can sign in, subscribe, enable cloud AI providers, sync their data, and continue using cloud calls only while entitled.

## Problem

The app already contains cloud-oriented code paths, but exposing them without billing would allow unpaid use of paid Azure inference and account-backed sync. UI-only gating is insufficient because callers could invoke Edge Functions directly if server-side entitlement checks are missing or functions remain callable with only an anon key.

This feature must therefore add a subscription entitlement layer that is enforced consistently in:

1. Client navigation and settings.
2. Provider selection and mode overrides.
3. Supabase Edge Functions.
4. Subscription lifecycle handling.
5. Downgrade behavior when entitlement expires.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app:

- Frontend source lives in `src/`.
- Tauri backend lives in `src-tauri/`.
- Supabase Edge Functions live under `supabase/functions/`.
- The app has two windows:
  - `main` for settings/management UI.
  - `overlay` for recording and transcription flow.
- AI provider abstraction lives in `src/lib/ai/AIProvider.ts`.
- Provider selection is coordinated by `src/lib/ai/index.ts`.
- Existing provider implementations include:
  - `SupabaseAIProvider` for cloud transcription/cleanup.
  - `LocalWhisperProvider` for local Whisper.
  - `ParakeetProvider` for local Parakeet.
  - `OllamaProvider` for local cleanup.
- App mode is stored by `src/lib/appMode.ts` using `sw.app.mode` with `"local"` and `"cloud"`.
- State stores use Zustand under `src/lib/store/`.
- LocalStorage cache keys are prefixed with `sw.` so the overlay can read synchronously.
- Cloud account/auth surfaces include `useAuth`, account UI, auth gating, and migration flows.
- Recording starts from hotkey events, resolves a Mode, captures audio in the overlay, selects the active provider, then pastes the result through the Rust `paste_to_target` command.

Expected baseline after issue #21:

- Cloud UI surfaces are hidden behind a single cloud feature flag.
- Cloud implementation code remains present but inactive from the default UI.
- Local transcription/cleanup remains usable.

## Tech Stack

- Desktop shell: Tauri 2
- Frontend: React, TypeScript, Vite
- State: Zustand
- Styling: CSS custom properties in `src/styles/tokens.css`, Tailwind token mappings
- Backend: Rust Tauri commands
- Cloud backend: Supabase Auth, Postgres, Edge Functions
- Billing: Stripe Checkout, Stripe Customer Portal, Stripe webhooks
- Cloud inference: Azure Whisper transcription and Azure GPT cleanup through Supabase Edge Functions

## Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm tauri dev
pnpm tauri build
supabase db push
supabase functions deploy transcribe --no-verify-jwt
supabase functions deploy cleanup --no-verify-jwt
```

Implementation should revisit the `--no-verify-jwt` deployment mode for paid cloud paths. The preferred end state is that paid inference functions require authenticated Supabase JWTs and perform entitlement checks before invoking Azure.

## Project Structure

```text
src/
  App.tsx                         Main app routes and gated cloud/account surfaces
  lib/
    ai/                           Provider abstraction and implementations
    appMode.ts                    local/cloud app mode state
    entitlement.ts                New entitlement client helpers/store
    billing.ts                    New billing checkout/customer portal helpers
    store/                        Zustand stores for auth, modes, vocab, profile, mappings
    recording-bridge.ts           Main-to-overlay recording coordination
  overlay/
    Overlay.tsx                   Recording flow and provider invocation UI
  styles/
    tokens.css                    Design tokens

src-tauri/
  src/commands/                   Native commands for hotkey, paste, local providers, active window

supabase/
  migrations/                     Subscription/entitlement schema and RLS policies
  functions/
    transcribe/                   Cloud transcription proxy; must enforce entitlement
    cleanup/                      Cloud cleanup proxy; must enforce entitlement
    billing-webhook/              New Stripe webhook handler
    create-checkout-session/      New authenticated checkout function
    customer-portal/              New authenticated portal function

docs/
  automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md
  billing-cloud-entitlements.md   New or updated operator documentation
```

## Architecture

### Entitlement Model

Use Supabase Postgres as the entitlement source of truth, populated by billing webhooks.

Recommended tables:

```sql
subscriptions
  id uuid primary key
  user_id uuid references auth.users(id) not null
  provider text not null
  provider_customer_id text not null
  provider_subscription_id text unique
  status text not null
  current_period_end timestamptz
  cancel_at_period_end boolean not null default false
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

entitlements
  id uuid primary key
  user_id uuid references auth.users(id) not null
  key text not null
  active boolean not null
  source text not null
  valid_until timestamptz
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()
  unique(user_id, key)
```

Initial entitlement keys:

```text
cloud_ai
cloud_sync
```

Subscription statuses that grant entitlement:

```text
trialing
active
past_due_with_grace
```

Statuses that do not grant entitlement:

```text
incomplete
incomplete_expired
past_due
canceled
unpaid
paused
```

If a grace period is desired, it must be represented explicitly by `valid_until`; client-side grace must never bypass server-side enforcement.

### Client Entitlement Flow

Add a client entitlement store/hook, for example:

```ts
type [REDACTED] | 'cloud_sync';

type EntitlementState = {
  loading: boolean;
  entitlements: Record<EntitlementKey, boolean>;
  expiresAt?: string;
  refresh: () => Promise<void>;
  has: (key: EntitlementKey) => boolean;
};
```

Client responsibilities:

- Read authenticated entitlement state from Supabase.
- Cache only non-sensitive entitlement booleans and expiry timestamps.
- Hide cloud provider options unless `cloud_ai` is active.
- Hide sync/account upgrade paths unless cloud features are available.
- Keep local provider defaults available for all users.
- Downgrade invalid cloud selections to safe local defaults when entitlement is missing or expires.
- Surface a clear upgrade CTA instead of showing dead-end cloud controls to free users.

### Server Entitlement Flow

Every paid cloud Edge Function must:

1. Require an authenticated Supabase user.
2. Verify the JWT with Supabase Auth.
3. Query active entitlement for the user.
4. Reject missing/expired entitlement before reading or forwarding paid inference payloads.
5. Only then call Azure.

Expected rejection:

```json
{
  "error": "cloud_ai_entitlement_required",
  "message": "Cloud AI requires an active subscription."
}
```

Recommended HTTP status:

```text
401 unauthenticated when no valid user token is present
403 forbidden when authenticated but not entitled
429 too many requests when usage limits are exceeded
```

### Billing Flow

Recommended Stripe flow:

1. Signed-in user clicks Upgrade.
2. Client calls authenticated `create-checkout-session` Edge Function.
3. Function creates or reuses a Stripe customer mapped to the Supabase user.
4. User completes Stripe Checkout in browser.
5. Stripe webhook validates signature and updates `subscriptions` plus `entitlements`.
6. Client refreshes entitlement state.
7. Subscribed user can enable cloud AI and sync.
8. User manages billing through authenticated `customer-portal` Edge Function.

Webhook handling must be idempotent and keyed by Stripe event ID and subscription/customer IDs.

### Provider Selection

Provider selection should be entitlement-aware but not trust the client for enforcement.

Rules:

- Free user:
  - Transcription options: local providers only.
  - Cleanup options: local providers only.
  - Cloud sync: hidden or disabled with upgrade explanation.
- Entitled user:
  - Can choose cloud transcription through Supabase/Azure.
  - Can choose cloud cleanup through Supabase/Azure.
  - Can opt into cloud sync.
- Lapsed user:
  - Existing local data remains intact.
  - Cloud selections are replaced by local fallbacks.
  - Synced data is not deleted.
  - Sync writes stop until entitlement returns.
  - UI explains that cloud access is paused.

### Account and Sync

Cloud AI requires an authenticated account. Account creation/sign-in is the entry point for subscription purchase and sync.

Cloud sync should be separately gated by `cloud_sync`, even if the first paid plan grants both `cloud_ai` and `cloud_sync`. Keeping separate keys prevents future coupling if plan tiers diverge.

### Privacy Copy

Privacy messaging must distinguish:

- Local mode: audio/text stays local except local model downloads or explicitly configured local services.
- Cloud AI: audio/text is sent to Supabase Edge Functions and Azure for transcription/cleanup.
- Cloud sync: account data is synced to Supabase.

Any overlay or settings indicator should reflect the actual selected provider at recording time.

## Security Requirements

- Do not expose Azure API keys to the client.
- Do not rely on UI gating for paid inference protection.
- Do not deploy paid inference functions in a mode that permits anonymous paid calls.
- Validate Supabase JWTs server-side.
- Enforce entitlement before invoking Azure or performing paid work.
- Validate Stripe webhook signatures.
- Make webhook processing idempotent.
- Store only required billing identifiers, not full Stripe payloads.
- Use RLS on subscription and entitlement tables.
- Users may read only their own subscription/entitlement records.
- Users may not directly write entitlement records.
- Edge Functions should use service-role access only where necessary.
- Log entitlement decisions without logging audio, transcript text, cleanup text, tokens, secrets, or full request bodies.
- Prevent localStorage entitlement cache from becoming a source of authority.
- Treat offline entitlement as UI-only; server calls must still require live validation.
- Add rate limiting or usage metering before public paid launch if plan limits exist.

## Code Style

Prefer small typed helpers and explicit guards:

```ts
export type [REDACTED] | 'cloud_sync';

export function canUseCloudProvider(
  key: EntitlementKey,
  entitlements: Record<EntitlementKey, boolean>,
): boolean {
  return entitlements[key] === true;
}

export function requireLocalFallback<T extends { provider: string }>(
  value: T,
  hasCloudAI: boolean,
  fallback: T,
): T {
  if (value.provider === 'supabase' && !hasCloudAI) {
    return fallback;
  }

  return value;
}
```

Conventions:

- Use TypeScript unions for entitlement keys and subscription statuses.
- Avoid `as any`.
- Keep Supabase and Stripe secrets in server-side environments only.
- Use existing Zustand store patterns.
- Use existing CSS tokens; do not introduce hard-coded colors.
- Keep overlay-compatible state available through existing `sw.` localStorage conventions, but never treat cached entitlement as authoritative.

## Testing Strategy

### Unit Tests

Cover:

- Entitlement helper behavior.
- Provider option filtering.
- Cloud-to-local downgrade behavior.
- Subscription status to entitlement mapping.
- Expiry and grace-period calculations.
- UI copy branching for local vs cloud providers.

### Client Integration Tests

Cover:

- Free user sees local-only provider choices.
- Entitled user sees cloud provider choices.
- Lapsed user loses cloud choices without losing local data.
- Account/sync routes are reachable only when appropriate.
- Mode overrides cannot persist unavailable cloud providers for unentitled users.
- Overlay uses the resolved provider state and does not show misleading privacy copy.

### Supabase Function Tests

Cover:

- `transcribe` rejects unauthenticated requests.
- `transcribe` rejects authenticated but unentitled users.
- `transcribe` invokes Azure only for entitled users.
- `cleanup` rejects unauthenticated requests.
- `cleanup` rejects authenticated but unentitled users.
- `cleanup` invokes Azure only for entitled users.
- Stripe webhook rejects invalid signatures.
- Stripe webhook updates subscription and entitlement state idempotently.

### Manual QA

Scenarios:

1. Fresh install, no account: local-only experience.
2. Sign up but no subscription: local-only experience with upgrade path.
3. Subscribe: cloud AI and sync become available.
4. Select cloud transcription and cloud cleanup: recording succeeds.
5. Cancel at period end: access remains until period end.
6. Subscription lapses: app downgrades to local providers.
7. Resubscribe: cloud selections can be restored or reselected.
8. Server rejects entitlement after client cache says active: UI surfaces clear error and refreshes entitlement.

## Screenshots to Capture for Review

Capture screenshots for the implementation PR:

1. Free user settings showing local-only AI provider choices.
2. Free user upgrade/account entry point.
3. Signed-in unsubscribed user billing CTA.
4. Stripe Checkout launch state or mocked checkout handoff.
5. Entitled user settings showing cloud transcription and cleanup options.
6. Entitled user account/sync screen.
7. Overlay privacy indicator while using local provider.
8. Overlay privacy indicator while using cloud provider.
9. Lapsed subscription downgrade message.
10. Server-side rejection error surfaced in the UI.

Screenshots must avoid real personal data, emails, subscription IDs, API keys, and transcript content.

## Implementation Plan

### Phase 1: Entitlement Foundation

- Add Supabase schema for subscriptions and entitlements.
- Add RLS policies.
- Add typed entitlement client helpers.
- Add Zustand entitlement store.
- Add entitlement refresh during app hydration.

### Phase 2: Billing Integration

- Add Stripe customer mapping.
- Add authenticated checkout session function.
- Add authenticated customer portal function.
- Add Stripe webhook function.
- Add webhook idempotency.

### Phase 3: Server Enforcement

- Update `transcribe` function to require authenticated entitled users.
- Update `cleanup` function to require authenticated entitled users.
- Add shared entitlement verification helper for Edge Functions.
- Update deployment docs to avoid anonymous paid inference.

### Phase 4: Client Gating

- Replace static cloud feature flag behavior with entitlement-aware gating.
- Re-enable cloud provider options only for entitled users.
- Restore account, auth gate, and migration/sync paths as paid-tier entry points.
- Add downgrade behavior for expired entitlement.
- Update privacy copy.

### Phase 5: Verification and Documentation

- Add tests for entitlement, billing, provider gating, and Edge Function enforcement.
- Add billing and entitlement operations docs.
- Capture screenshots.
- Run build, lint, and targeted tests.

## Task Breakdown

- [ ] Task: Add subscription and entitlement schema
  - Acceptance: Supabase stores subscription state and active entitlement keys per user.
  - Verify: migration applies cleanly and RLS prevents direct writes by normal users.
  - Files: `supabase/migrations/*`

- [ ] Task: Add Stripe webhook entitlement sync
  - Acceptance: Stripe lifecycle events update subscriptions and entitlements idempotently.
  - Verify: valid signed webhook updates state; invalid signature is rejected.
  - Files: `supabase/functions/billing-webhook/*`

- [ ] Task: Add checkout and customer portal functions
  - Acceptance: signed-in users can start checkout and open billing portal.
  - Verify: unauthenticated calls fail; authenticated calls return Stripe URLs.
  - Files: `supabase/functions/create-checkout-session/*`, `supabase/functions/customer-portal/*`

- [ ] Task: Add client entitlement store
  - Acceptance: app can load, cache, refresh, and query entitlement booleans.
  - Verify: unit tests cover active, inactive, expired, and loading states.
  - Files: `src/lib/entitlement.ts`, `src/lib/store/*`

- [ ] Task: Gate cloud provider selection
  - Acceptance: free users see local-only providers; entitled users see cloud providers.
  - Verify: UI/provider tests cover free, entitled, and lapsed states.
  - Files: `src/lib/ai/index.ts`, settings/onboarding/mode provider components`

- [ ] Task: Enforce entitlement in cloud Edge Functions
  - Acceptance: paid Azure calls are impossible without authenticated entitlement.
  - Verify: function tests prove unentitled users receive 403 and Azure is not called.
  - Files: `supabase/functions/transcribe/*`, `supabase/functions/cleanup/*`

- [ ] Task: Restore account and sync paid-tier paths
  - Acceptance: account/sync flows are available as subscription entry points without dead ends.
  - Verify: free and entitled navigation tests pass.
  - Files: `src/App.tsx`, account/auth/migration components, relevant stores`

- [ ] Task: Add downgrade and failure UX
  - Acceptance: lapsed users are moved to local providers without data loss and see clear messaging.
  - Verify: tests cover persisted cloud settings being sanitized for unentitled users.
  - Files: provider settings, mode overrides, entitlement refresh handling`

- [ ] Task: Update documentation and screenshots
  - Acceptance: billing setup, entitlement model, deployment mode, and QA screenshots are documented.
  - Verify: docs review confirms no secrets or PII are included.
  - Files: `docs/billing-cloud-entitlements.md`, PR screenshots`

## Acceptance Criteria

- Free users without an active subscription see a local-only experience with no cloud provider dead ends.
- Signed-in but unsubscribed users cannot call cloud transcription or cleanup successfully.
- Subscribed users can select and use cloud transcription.
- Subscribed users can select and use cloud cleanup.
- Subscribed users can enable account-backed sync.
- Edge Functions reject unauthenticated requests before paid work.
- Edge Functions reject authenticated but unentitled requests before paid work.
- Subscription lifecycle events correctly grant, preserve, revoke, and restore entitlements.
- Lapsed users are downgraded to local providers without deleting local or synced data.
- Billing setup and entitlement enforcement are documented.
- Screenshots show free, subscribed, cloud, local, and lapsed states.
- Tests cover at least one server-side rejection path for each paid Edge Function.

## Boundaries

### Always

- Preserve the free local-only workflow.
- Enforce paid cloud access server-side.
- Keep Azure and Stripe secrets server-side.
- Use existing store, provider, and styling patterns.
- Add tests for entitlement and Edge Function enforcement.
- Redact PII and secrets from screenshots and docs.

### Ask First

- Changing billing provider away from Stripe.
- Adding usage-based metering or hard usage caps.
- Adding new paid tiers beyond free and paid cloud.
- Changing Supabase project auth strategy globally.
- Deleting existing cloud/account code instead of re-gating it.
- Changing CI or release signing behavior.

### Never

- Expose paid inference through anonymous calls.
- Trust localStorage entitlement cache for server authorization.
- Commit API keys, webhook secrets, customer IDs from real users, or raw billing payloads.
- Log audio, transcripts, cleanup text, or full inference payloads.
- Delete user data when subscription lapses.
- Hide server rejection errors behind silent local fallback.

## Open Questions

1. Confirm Stripe as billing provider.
2. Confirm whether the first paid tier grants both `cloud_ai` and `cloud_sync`.
3. Decide whether trials are supported at launch.
4. Decide whether grace periods are supported and how long they last.
5. Decide whether usage caps or metering are required for launch.
6. Decide whether cloud sync should remain available after cancellation until period end.
7. Decide whether lapsed cloud provider choices should be remembered and restored after resubscription.
8. Confirm final deployment mode for paid Edge Functions and whether existing anonymous deployment remains only for non-paid/local-compatible paths.
```

