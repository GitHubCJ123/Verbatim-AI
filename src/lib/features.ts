/**
 * Build-time feature flags.
 *
 * `CLOUD_FEATURES_ENABLED` is the single master switch for every
 * cloud-dependent surface: Azure AI (transcription + cleanup) proxied
 * through Supabase Edge Functions, plus the cloud account/sync app mode
 * (sign-in, Account page, migration). While it is `false` the app is a
 * fully local-only experience. No cloud code is removed — flipping this
 * back to `true` re-enables every gated surface (see issue #21).
 *
 * Gating is applied at the data/resolution layer (app mode + provider
 * kind resolution) so stale `"cloud"` values already persisted in
 * localStorage or per-Mode overrides resolve to a local engine at read
 * time. The stored values themselves are preserved (non-destructive), so
 * re-enabling restores the user's previous cloud selection.
 *
 * Typed as `boolean` (rather than the literal `false`) on purpose: it
 * keeps the many downstream `if (CLOUD_FEATURES_ENABLED)` / `=== "cloud"`
 * branches from being flagged as statically dead by the type-checker and
 * linter, so the code that we intend to reactivate later stays intact.
 */
export const CLOUD_FEATURES_ENABLED: boolean = false;
