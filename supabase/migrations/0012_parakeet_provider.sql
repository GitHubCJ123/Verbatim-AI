-- Add 'local-parakeet' to the transcribe_provider allowed values.
-- Parakeet TDT v3 is the on-device, multilingual sherpa-onnx provider
-- shipped in app v0.4+.

alter table public.modes
  drop constraint if exists modes_transcribe_provider_check;

alter table public.modes
  add constraint modes_transcribe_provider_check
    check (
      transcribe_provider is null
      or transcribe_provider in ('cloud','local-whisper','local-parakeet')
    );
