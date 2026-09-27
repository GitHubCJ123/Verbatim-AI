# Requirements review for issue #13

Status: clear
Issue input SHA: e91f1df6081001c80d1f5f6a272b8c6ae35be1828bc6fda0a59166398e02414f

## Summary

Requirements are clear enough to draft a spec without a human requirements gate.

## Findings

- Issue is well-structured (problem/approach/acceptance context present).
- Issue includes concrete diagnostic evidence.

## Questions / blockers

- None.

## Next action

Proceed to spec drafting. Implementation still requires spec review and approval.

## Original issue

## Problem

The `transcribe` and `cleanup` Supabase Edge Functions are deployed with `--no-verify-jwt` so that local-mode (no-account) users can call them with the anon key. But `VITE_SUPABASE_ANON_KEY` is baked into the shipped bundle — anyone who extracts it can call the functions directly and burn Azure AI Foundry quota. There is currently no rate limiting or request-size cap either.

## Proposed fix (in preference order)

1. **Supabase anonymous sign-ins for local mode** — local-mode users get a real (anonymous) JWT at first launch, Edge Functions re-enable JWT verification, and rate limits become per-user. No UX change; local mode still means "no account you created".
2. Per-IP rate limiting inside the functions (Upstash / DB counter) as a cheaper stopgap.
3. Regardless of 1/2: cap request body size and audio duration server-side.

## Touched surfaces

- `supabase/functions/transcribe`, `supabase/functions/cleanup` (redeploy **without** `--no-verify-jwt`)
- `src/lib/appMode.ts` + `src/lib/ai/index.ts` (`getAuthHeaders` — swap anon-key bearer for an anonymous session token in local mode)
- Supabase dashboard: enable anonymous sign-ins

## Acceptance criteria

- Requests with only the anon key are rejected (or strictly rate-limited).
- Local-mode users experience no change (no sign-up, no prompts).
- Server rejects oversized bodies / absurd audio durations.

## Reference

Full analysis: `docs/improvement-plan/05-security-privacy.md`, finding **F2** (lands with branch `improvements/plan-implementation`). Findings F1/F3/F5 from the same doc are already implemented on that branch.
