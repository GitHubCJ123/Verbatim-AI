<!-- verbatim-ai:artifact:v1 issue=22 phase=spec id=issue-0022-issue-0022-1a4713e3-99bc-4a34-be50-d1c282653634-SPEC-006 display=SPEC-006 run=issue-0022-1a4713e3-99bc-4a34-be50-d1c282653634 -->
# SPEC-006: Architect spec

- Issue: #22
- Phase: spec
- Prefix: SPEC
- Artifact ID: issue-0022-issue-0022-1a4713e3-99bc-4a34-be50-d1c282653634-SPEC-006
- Agent: architect
- Run: issue-0022-1a4713e3-99bc-4a34-be50-d1c282653634
- Created: 2026-07-25T05:30:00.256Z

## Summary

Spec

## Body

# Spec

Proposed content for `docs/automation/specs/issue-0022-reintroduce-cloud-ai-models-account-sync-behind/spec.md`:

```markdown
# Spec: Issue #22 - Reintroduce Cloud AI Models + Account Sync Behind Subscription Entitlements

## Assumptions

1. Stripe Checkout + Stripe Customer Portal is the default billing provider for the desktop app unless maintainers choose otherwise.
2. Supabase remains the source of truth for authentication, synced user data, and entitlement persistence.
3. Cloud AI requires a signed-in account and an active entitlement.
4. Local transcription/cleanup remains free, accountless, and fully usable.
5. Entitlements must be enforced server-side before any Azure-backed inference call.
6. Existing cloud code paths preserved by issue #21 should be reused rather than rebuilt.

## Objective

Reintroduce Verbatim AI cloud features as a paid tier:

- Azure-backed Whisper transcription.
- Azure GPT cleanup.
- Supabase-backed account sync for modes, vocabulary, profile, mappings, and related cloud-state.
- Account, onboarding, migration, and upgrade flows that guide local users into the paid cloud tier without breaking the free local experience.

Success means free users continue to see a local-only app with no dead-end cloud controls, while subscribed users can sign in, enable sync, choose cloud AI providers, and successfully use cloud transcription/cleanup. Server-side functions must reject unentitled requests even if the client is modified.

## Current Repo Facts

Verbatim AI is a Tauri 2 desktop app with a Rust backend in `src-tauri/` and a React/TypeScript frontend in `src/`.

Relevant existing architecture:

- Frontend entrypoints:
  - `src/App.tsx` renders the main settings/management UI.
  - `src/overlay/Overlay.tsx` renders the always-on-top recording overlay from `overlay.html`.
- Recording flow:
  - Rust global hotkey emits `hotkey:down` / `hotkey:up`.
  - `src/lib/hotkey.ts` receives hotkey events.
  - `src/lib/modeResolver.ts` resolves the active mode from localStorage and foreground app metadata.
  - `src/lib/recording-bridge.ts` starts overlay recording.
  - `src/lib/audio.ts` records microphone audio.
  - `src/lib/ai/index.ts` selects the active provider.
  - Rust command `paste_to_target` pastes text back into the original app.
- Existing AI providers:
  - `SupabaseAIProvider` proxies cloud transcription/cleanup through Supabase Edge Functions.
  - `LocalWhisperProvider` uses local `whisper-cli`.
  - `ParakeetProvider` uses local `sherpa-onnx`.
  - `OllamaProvider` supports local cleanup only.
- App mode:
  - `src/lib/appMode.ts` stores `sw.app.mode` as `local` or `cloud`.
  - Local mode does not require Supabase auth.
  - Cloud mode uses Supabase auth and sync.
- State:
  - Stores live under `src/lib/store/`.
  - Stores write localStorage caches prefixed with `sw.` so the overlay can read synchronously.
  - `hydrateAll()` seeds local data or hydrates from Supabase.
- Supabase Edge Functions:
  - `supabase/functions/transcribe`
  - `supabase/functions/cleanup`
  - Existing deployment notes mention `--no-verify-jwt`; paid cloud inference must revisit this.

## Tech Stack

- Desktop shell: Tauri 2
- Frontend: React, TypeScript, Vite
- State: Zustand
- Backend commands: Rust
- Auth/data: Supabase
- Cloud functions: Supabase Edge Functions
- Cloud inference: Azure Whisper transcription and Azure GPT cleanup
- Proposed billing: Stripe Checkout + Stripe Customer Portal
- Styling: CSS custom properties in `src/styles/tokens.css`; Tailwind maps to those tokens

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

Cloud function deployment for paid inference should require JWT verification unless a deliberate alternative auth verification strategy is documented.

## Project Structure

```text
src/
  App.tsx
  components/
  lib/
    ai/
      AIProvider.ts
      index.ts
      localWhisper.ts
      parakeet.ts
      ollama.ts
    appMode.ts
    hotkey.ts
    modeResolver.ts
    recording-bridge.ts
    store/
  overlay/
    Overlay.tsx
src-tauri/
  src/
    commands/
supabase/
  functions/
    transcribe/
    cleanup/
  migrations/
docs/
  automation/
    specs/
      issue-0022-reintroduce-cloud-ai-models-account-sync-behind/
        spec.md
```

Likely new or changed areas:

- Client entitlement store/hook under `src/lib/store/` or `src/lib/entitlements.ts`.
- Billing/upgrade UI in existing Account/AuthGate/onboarding/settings surfaces.
- Supabase migration for billing customers, subscriptions, entitlements, and usage metadata.
- Edge Function entitlement helpers shared by `transcribe` and `cleanup`.
- Tests for entitlement gating, provider selection, downgrade behavior, and Edge Function authorization.

## Product Model

### Free tier

Free users get:

- Local transcription providers.
- Local cleanup providers.
- Local-only modes/vocabulary/profile/app mappings.
- No visible cloud AI provider choices.
- No visible account-sync controls except intentional upgrade entrypoints.
- No broken routes or disabled controls that imply unavailable cloud features.

### Paid tier

Subscribed users get:

- Cloud transcription through Supabase/Azure.
- Cloud cleanup through Supabase/Azure.
- Account sync through Supabase.
- Account management and billing portal access.
- Safe downgrade to local behavior when entitlement expires.

### Account requirement

Cloud AI and sync require an authenticated Supabase user. Anonymous use remains local-only.

## Entitlement Architecture

Supabase should be the app-facing entitlement source of truth. Billing provider webhooks update Supabase tables. Clients read entitlement state from Supabase. Edge Functions independently verify the authenticated user and entitlement before proxying to Azure.

Recommended data model:

```sql
billing_customers
  user_id uuid primary key references auth.users(id)
  provider text not null
  provider_customer_id text not null unique
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

subscriptions
  id uuid primary key default gen_random_uuid()
  user_id uuid not null references auth.users(id)
  provider text not null
  provider_subscription_id text not null unique
  status text not null
  tier text not null
  current_period_start timestamptz
  current_period_end timestamptz
  cancel_at_period_end boolean not null default false
  trial_end timestamptz
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

entitlements
  user_id uuid primary key references auth.users(id)
  tier text not null
  cloud_ai_enabled boolean not null default false
  sync_enabled boolean not null default false
  effective_until timestamptz
  source text not null
  updated_at timestamptz not null default now()

usage_events
  id uuid primary key default gen_random_uuid()
  user_id uuid not null references auth.users(id)
  feature text not null
  provider text not null
  units numeric
  metadata jsonb not null default '{}'
  created_at timestamptz not null default now()
```

Status values should be normalized and documented. Recommended active entitlement statuses:

- `trialing`
- `active`
- `past_due` only if within a documented grace window

Non-entitled statuses:

- `canceled`
- `unpaid`
- `incomplete`
- `incomplete_expired`
- `paused`

## Client Architecture

Add a client entitlement layer that exposes:

```ts
type EntitlementState = {
  loading: boolean;
  authenticated: boolean;
  tier: 'free' | 'pro';
  cloudAiEnabled: boolean;
  syncEnabled: boolean;
  effectiveUntil: string | null;
};
```

Client behavior:

- Default to local-only while entitlement is loading or unavailable.
- Never show cloud AI provider options unless `cloudAiEnabled` is true.
- Never enable cloud sync unless `syncEnabled` is true.
- If entitlement lapses, preserve user data and downgrade active provider selections to local defaults.
- If a previously selected cloud provider becomes unavailable, show a clear downgrade notice in the main UI and keep recording usable.
- Overlay must not depend on a network entitlement fetch at recording time. It should consume cached settings that have already been downgraded or validated by the main app.
- Provider selection must still be server-enforced; client gating is UX only.

Recommended provider behavior:

- Free/unentitled users:
  - Transcription: local provider only.
  - Cleanup: local provider only.
- Entitled users:
  - Can choose cloud or local transcription globally and per mode.
  - Can choose cloud or local cleanup globally and per mode.
- Entitlement revoked:
  - Cloud selections are retained as user preferences if safe, but inactive.
  - Effective runtime provider falls back to local.
  - UI explains that cloud choices require an active subscription.

## Server Architecture

`supabase/functions/transcribe` and `supabase/functions/cleanup` must verify:

1. Request has a valid Supabase user JWT.
2. The JWT user matches the user whose entitlement is checked.
3. User has an active entitlement for the requested feature.
4. Optional usage caps or rate limits are not exceeded.
5. Only then proxy to Azure.

The anon key alone must not authorize paid inference.

Recommended shared flow:

```ts
const user = await requireAuthenticatedUser(req);
const entitlement = await requireEntitlement(user.id, 'cloud_ai');
await recordUsageAttempt(user.id, feature);
const result = await callAzure(...);
await recordUsageSuccess(user.id, feature, usage);
return result;
```

Rejected requests should return:

- `401` for missing/invalid authentication.
- `403` for authenticated but unentitled users.
- `429` for usage/rate limits if implemented.
- No Azure call should be made before entitlement passes.

## Billing Architecture

Recommended Stripe flow:

1. User clicks upgrade in Account/onboarding/settings.
2. App opens Stripe Checkout session created by a Supabase function or trusted backend endpoint.
3. Stripe webhook receives subscription lifecycle events.
4. Webhook validates Stripe signature.
5. Webhook upserts `billing_customers`, `subscriptions`, and `entitlements`.
6. Client refreshes entitlement state after checkout completion and periodically on app launch.
7. Billing portal link lets subscribed users manage cancellation/payment methods.

Webhook events to handle:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

Webhook handlers must be idempotent.

## Security Requirements

- Do not expose Azure credentials in the client.
- Do not rely on client-side feature flags for paid access.
- Require authenticated Supabase users for cloud inference.
- Enforce entitlement inside every paid Edge Function.
- Validate Stripe webhook signatures.
- Store only billing IDs and subscription metadata needed for entitlement decisions.
- Do not store full payment details.
- Apply RLS to billing and entitlement tables.
- Users may read only their own entitlement/subscription summary.
- Only trusted server/webhook roles may write subscription and entitlement rows.
- Avoid logging audio, transcripts, cleanup text, JWTs, Stripe secrets, Azure keys, or PII.
- Usage logs should avoid raw transcript content.
- Entitlement cache must fail closed to local-only behavior.
- Server-side downgrade/rejection must produce clear errors without leaking internals.

## Privacy Requirements

- Local mode remains local-first and accountless.
- Cloud mode must clearly disclose that audio/transcript text is sent to cloud services.
- Privacy indicator/copy should distinguish:
  - Local transcription.
  - Local cleanup.
  - Cloud transcription.
  - Cloud cleanup.
  - Sync enabled/disabled.
- Switching from local to cloud should be explicit.
- Downgrading from cloud to local must not delete local user data.

## Failure UX

Required states:

- Signed out user selects cloud upgrade:
  - Prompt to create/sign into account.
- Signed in but unsubscribed user opens cloud settings:
  - Show upgrade CTA and keep local providers active.
- Entitled user loses subscription:
  - Show subscription inactive notice.
  - Fall back to local providers.
  - Preserve modes/vocabulary/mappings locally.
- Server rejects cloud call:
  - Show actionable message.
  - Do not lose recorded audio if retry/fallback is feasible.
  - Offer local retry where supported.
- Offline:
  - Existing local features continue.
  - Cloud entitlement refresh is deferred.
  - Cached entitlement may be honored only within a documented grace policy; otherwise cloud fails closed.

## Testing Strategy

### Unit tests

Cover:

- Entitlement state derivation from subscription rows.
- Provider visibility based on entitlement.
- Effective provider fallback when cloud is unavailable.
- App mode transitions between local and cloud.
- Downgrade behavior when entitlement lapses.
- Error mapping for `401`, `403`, and `429` Edge Function responses.

### Integration tests

Cover:

- Free user sees local-only settings.
- Subscribed user sees cloud AI options and account sync.
- Signed-in unentitled user cannot select cloud provider.
- Existing cloud provider preference falls back to local after entitlement expires.
- `hydrateAll()` does not enable sync for unentitled users.
- Overlay reads safe effective provider state from localStorage cache.

### Supabase/Edge Function tests

Cover:

- Missing JWT rejects `transcribe`.
- Missing JWT rejects `cleanup`.
- Valid JWT without entitlement rejects both functions with `403`.
- Valid JWT with entitlement allows function to reach mocked Azure call.
- Expired subscription rejects.
- Trialing/active subscription allows.
- Webhook updates entitlement idempotently.
- RLS prevents users from reading other users' billing rows.

### Manual QA

Scenarios:

1. Fresh install, no account: local-only onboarding and recording.
2. Existing local user upgrades: account creation, checkout, entitlement refresh, sync opt-in.
3. Subscribed user selects Azure transcription + cleanup and records successfully.
4. Subscription canceled at period end: access remains until entitlement expiry.
5. Subscription expired: local fallback works, cloud options hidden or marked upgrade-required.
6. Offline launch: local recording works.
7. Server entitlement rejection: user sees clear failure and can continue locally.

## Screenshots / Visual Evidence Required

Implementation PR should include screenshots or screen recordings for:

- Free local-only settings/provider UI.
- Upgrade/account entrypoint.
- Signed-in subscribed settings with cloud transcription/cleanup options visible.
- Account/sync enabled state.
- Entitlement-lapsed downgrade notice.
- Server-side rejection UX for an unentitled cloud attempt.
- Privacy indicator/copy showing local vs cloud behavior.

## Acceptance Criteria

- Free users without an active entitlement see a local-only app experience with no selectable cloud AI provider options.
- Free users can continue recording, transcribing, cleaning up, and pasting using local providers.
- Cloud AI and sync require account authentication.
- Subscribed users can select cloud transcription and cloud cleanup globally and per mode where provider overrides are supported.
- Subscribed users can enable account sync.
- Edge Functions reject unauthenticated cloud inference calls.
- Edge Functions reject authenticated but unentitled cloud inference calls.
- Entitled Edge Function calls can reach Azure-backed transcription/cleanup.
- Subscription lifecycle changes update entitlement state.
- Lapsed/canceled/expired users downgrade safely to local providers without data loss.
- Billing webhook handling is idempotent and documented.
- Billing, entitlement, and downgrade behavior are documented.
- Tests cover client gating and server-side enforcement.

## Boundaries

### Always do

- Preserve local-only behavior for free users.
- Enforce paid access server-side.
- Keep client entitlement gating as UX only, not security.
- Fail closed to local-only when entitlement is missing or invalid.
- Avoid logging secrets, audio, transcripts, cleanup output, or payment details.
- Use existing provider/store/router patterns where possible.
- Use design tokens from `src/styles/tokens.css`.

### Ask first

- Final billing provider choice if not Stripe.
- Pricing, tier names, trial length, and grace-period policy.
- Usage caps, metering units, and overage behavior.
- Whether cloud sync and cloud AI can be purchased separately.
- Whether app-store billing is required for any distribution channel.
- Any database schema that conflicts with existing Supabase conventions.

### Never do

- Ship Azure inference reachable with only the anon key.
- Trust a client flag as proof of subscription.
- Commit Stripe, Supabase service-role, or Azure secrets.
- Store raw payment details.
- Delete local user data during downgrade.
- Hide local functionality behind account creation.

## Open Questions

1. Is Stripe confirmed, or should RevenueCat/app-store billing remain under consideration?
2. What are the paid tier name, price, and trial length?
3. Are cloud AI and sync bundled into one entitlement or separate entitlements?
4. Is there a monthly transcription minute or cleanup token cap?
5. Should `past_due` users receive a grace period?
6. How long may cached entitlements be honored offline?
7. Should lapsed users retain visible but locked cloud provider preferences, or should cloud options disappear entirely?
8. What exact privacy copy is required for cloud transcription and cleanup?
```

