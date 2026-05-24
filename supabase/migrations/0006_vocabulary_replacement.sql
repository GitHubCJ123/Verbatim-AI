-- Adds an optional `replacement` column to vocabulary terms.
-- When set, SuperWisper will replace occurrences of `term` (case-insensitive,
-- whole-word) with `replacement` in cleaned output.

alter table public.vocabulary
  add column if not exists replacement text;
