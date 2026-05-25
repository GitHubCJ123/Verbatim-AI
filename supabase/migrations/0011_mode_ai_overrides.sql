-- Per-Mode AI overrides.
--
-- Each field is nullable. Null means "use the global setting from
-- Settings → AI model". When set on a Mode, the Mode wins.
--
-- - transcribe_provider : 'cloud' | 'local-whisper' (NULL = use global)
-- - whisper_tier        : 'tiny' | 'base' | 'small' | 'turbo' | 'large-v3'
--                         (only meaningful when transcribe_provider = 'local-whisper')
-- - cleanup_provider    : 'cloud' | 'local-ollama'  (NULL = use global)
-- - ollama_model        : Ollama tag, e.g. "qwen3.5:4b"
--                         (only meaningful when cleanup_provider = 'local-ollama')

alter table public.modes
  add column if not exists transcribe_provider text
    check (transcribe_provider is null or transcribe_provider in ('cloud','local-whisper')),
  add column if not exists whisper_tier text
    check (whisper_tier is null or whisper_tier in ('tiny','base','small','turbo','large-v3')),
  add column if not exists cleanup_provider text
    check (cleanup_provider is null or cleanup_provider in ('cloud','local-ollama')),
  add column if not exists ollama_model text;
