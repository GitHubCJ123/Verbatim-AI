-- Trigram search on transcript content (plan §17).
create extension if not exists pg_trgm;

create index transcriptions_cleaned_trgm_idx
  on public.transcriptions
  using gin (cleaned_text gin_trgm_ops);

create index transcriptions_raw_trgm_idx
  on public.transcriptions
  using gin (raw_text gin_trgm_ops);
