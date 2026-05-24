-- Per-mode toggle: when true, skip the LLM cleanup pass and use the raw
-- transcript directly. Vocabulary replacements still run.

alter table public.modes
  add column if not exists skip_cleanup boolean not null default false;
