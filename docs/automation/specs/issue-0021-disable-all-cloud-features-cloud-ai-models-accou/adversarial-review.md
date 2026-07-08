# Adversarial Review — Issue #21 spec

SPEC_REVIEW_DECISION: proceed

**Reviewer:** GPT-5.5 plan critic + Claude Opus 4.8 security/privacy audit (leave-one-out cross-family review).
**Verdict:** Proceed. The single-flag, read-time, non-destructive gating design is sound; concerns raised in review were integrated before implementation.

## Concerns raised and how they were resolved

1. **Re-enable must stay a clean flip (P0).** Original plan coerced cloud →
   local on *write*, which would clobber a stored `"cloud"`. Resolved:
   gating is **read-time only**; getters coerce, setters no-op on `"cloud"`
   when disabled, `getAppMode()` never mutates storage, and
   `getStoredAppMode()` preserves the raw value.

2. **Privacy indicator must not drift from the real pipeline (P0).**
   Resolved by extracting shared `effectiveTranscribeKind` /
   `effectiveCleanupKind` helpers used by BOTH `ai/index.ts` (provider
   resolution) and `privacyStatus.ts`, so the indicator cannot claim
   "on-device" while cloud is used.

3. **Stale per-Mode `"cloud"` overrides.** Resolved: provider resolution and
   the privacy status both wrap overrides in the effective-kind coercion;
   ModeEditor also shows a stale cloud override as "Use global default"
   (display-only, non-destructive).

4. **Transcribe-only providers' `cleanupFallback: getCloud()` is a latent
   cloud path.** Resolved: `cloudCleanupFallback()` returns a local provider
   when disabled (and the active composite pipeline never invokes it anyway).

5. **Tests without a browser env.** `jsdom` is not installed; resolved by
   testing pure effective-kind helpers (`cloudGating.test.ts`) with no
   `localStorage` dependency.

## Security/privacy audit result

PASS — with the flag off, no reachable code path sends audio or raw
transcript to Supabase/Azure; `getActiveProvider`, the Settings test
buttons, Overlay/History/ModeEditor cleanup all route through the gated
resolvers; boot never reaches AuthGate/Account/MigrationPicker or the cloud
hydrate branch; transcript/mode/vocab persistence stays local
(`isLocalMode()`-gated). No secret leak, no destructive coercion.

## Residual notes (non-blocking)

- `pnpm lint` is broken on `main` independently (ESLint 10 vs legacy
  `.eslintrc.json` + `--ext`); validation relies on tsc + vitest + build +
  cargo check.
- FeedbackDialog (Supabase) is pre-existing in local mode and out of scope.
