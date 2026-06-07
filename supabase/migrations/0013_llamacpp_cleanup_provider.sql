-- Add 'local-llamacpp' to the cleanup_provider allowed values.
-- llama.cpp's `llama-server` exposes the same OpenAI-compatible
-- /v1/chat/completions endpoint as the cloud path, so it is a
-- first-class, swappable cleanup backend alongside Cloud and Ollama.

alter table public.modes
  drop constraint if exists modes_cleanup_provider_check;

alter table public.modes
  add constraint modes_cleanup_provider_check
    check (
      cleanup_provider is null
      or cleanup_provider in ('cloud','local-ollama','local-llamacpp')
    );
