-- Add 'local-llama-cpp' to the cleanup_provider allowed values.
-- llama.cpp is a local LLM runtime for the cleanup/polish stage.

alter table public.modes
  drop constraint if exists modes_cleanup_provider_check;

alter table public.modes
  add constraint modes_cleanup_provider_check
    check (
      cleanup_provider is null
      or cleanup_provider in ('cloud','local-ollama','local-llama-cpp')
    );
