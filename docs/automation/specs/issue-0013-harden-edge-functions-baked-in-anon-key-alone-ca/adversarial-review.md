# Adversarial review

I'll review this spec. Let me first read the actual spec file and gather context on the touched surfaces.

● Read spec.md
  │ docs/automation/specs/issue-0013-harden-edge-functions-baked-in-anon-key-alone-ca/spec.md
  └ 366 lines read

● Read index.ts
  │ src/lib/ai/index.ts
  └ 334 lines read

● Read appMode.ts
  │ src/lib/appMode.ts
  └ 34 lines read

Let me verify the Supabase functions and client to validate the spec's assumptions.

● Read supabase.ts
  │ src/lib/supabase.ts
  └ 29 lines read

/ Search (glob)
  │ "supabase/functions/**/*.ts"
  └ 2 files found

/ Search (glob)
  │ "docs/improvement-plan/05-security-privacy.md"
  └ 1 file found

Let me read the Edge Functions and the referenced analysis doc (F2) to confirm the spec aligns with reality.

● Read index.ts
  │ supabase/functions/transcribe/index.ts
  └ 122 lines read

● Read index.ts
  │ supabase/functions/cleanup/index.ts
  └ 159 lines read

Let me confirm alignment with the referenced F2 analysis and check for existing test/config conventions.

/ Search (grep)
  │ "F2|anon|verify_jwt|no-verify-jwt|anonymous" (docs/improvement-plan/05-security-privacy.md)
  └ 15 lines found

/ Search (glob)
  │ "**/*.test.ts" in src
  └ 2 files found

/ Search (glob)
  │ "supabase/config.toml"
  └ 1 file found

● Check supabase config.toml for verify_jwt and anonymous auth settings (shell)
  │ cd [REDACTED_REPOSITORY] && grep -n -A3 -i "verify_jwt\|\[functions"
  │ supabase/config.toml 2>/dev/null | head -40; echo "---auth section---"; grep -n -A6 -i
  │ "\[auth\]\|anonymous\|sign_in_anon" supabase/config.toml 2>/dev/null | head -30
  └ 30 lines…

## Spec Review: Issue #13 — Harden Edge Functions

I verified the spec against the actual code (`src/lib/ai/index.ts`, `src/lib/appMode.ts`, both Edge Functions), the referenced analysis (`docs/improvement-plan/05-security-privacy.md` F2), and `supabase/config.toml`. The spec correctly reads the issue's intent: it implements F2 option 2 (anonymous sign-ins + re-enable JWT verification) plus option 3 (size/duration caps), and correctly defers per-IP rate limiting (option 1) — matching the doc's stated preference order. It meets the completeness bar: clear objective, acceptance criteria, and named files/components.

### Findings

**BLOCKING:** None.

**NON-BLOCKING (advisory):**

1. **Audio-duration check is post-Azure today.** `transcribe` only learns duration from Azure's `verbose_json` response (`data.duration`), i.e., *after* the paid call. Enforcing "reject excessive duration before provider invocation" from raw audio needs decoding. Practically, the **body-size cap is the real pre-call guard**; treat duration as a best-effort/post-hoc check. Implementer should not over-promise a true pre-call duration gate.

2. **Anonymous sign-in is config-tracked, not dashboard-only.** `supabase/config.toml` has `enable_anonymous_sign_ins = false` — flipping it is a reviewable code change, better than the "dashboard/operator-controlled" framing in the spec. Also note the built-in limit `anonymous_users = 30/hour/IP` already throttles sign-in abuse, which supports deferring extra rate limiting.

3. **Body-size enforcement placement.** `req.formData()` / `req.json()` buffer the whole body first. To actually save resources, check `Content-Length` (and/or a streamed limit) *before* buffering, not just after parsing.

4. **Rollout sequencing risk.** If the JWT-verifying redeploy, the `enable_anonymous_sign_ins` flip, and the new app build land out of order, existing local-mode users could be locked out. Coordinate deploy order. Operational; caught by the required human merge review.

5. **Comment/reality mismatch (resolved by this change).** Both functions' headers already claim "Supabase enforces a valid JWT" while deployed `--no-verify-jwt` — this change makes those comments true. Good.

6. **Cosmetic:** the on-disk file wraps the real spec inside a `Proposed content … ```markdown` fence; when finalized, the file should just *be* the spec.

Open questions (exact caps, rate-limiting now vs. later, doc location) are all normal implementer-resolvable details, and the spec supplies sensible defaults. The one policy-sensitive change (enable anonymous sign-ins) is explicitly requested by the issue, and paid-dep/DB/pricing changes are correctly gated under "Ask First." Downstream safety nets (draft PR, PR reviewer, lint/test/build, human merge) cover the residual risks.

SPEC_REVIEW_DECISION: proceed

