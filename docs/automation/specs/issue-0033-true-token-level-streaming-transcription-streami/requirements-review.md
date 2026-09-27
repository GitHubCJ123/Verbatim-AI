# Requirements review for issue #33

Status: clear
Issue input SHA: 817185043aca72b48bf4430f2b01930ed24adc90ea0d5e5e88f1bfd24ed660e7

## Summary

Requirements are clear enough to draft a spec without a human requirements gate.

## Findings

- No concrete findings recorded.

## Questions / blockers

- None.

## Next action

Proceed to spec drafting. Implementation still requires spec review and approval.

## Original issue

Follow-up from #23 (P2.6). The merged live-partial feature (#32) is chunked pseudo-streaming because the local engines (whisper-cli / whisper-server) are request/response. True token-level streaming needs a streaming-capable engine (e.g. whisper.cpp streaming/whisper-stream sidecar, or a streaming ONNX/parakeet path). Assess feasibility and implement a realistic increment; keep it opt-in and non-regressive.
