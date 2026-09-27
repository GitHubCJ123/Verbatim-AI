# Adversarial review

I'll review the spec. Let me first verify the actual spec file and ground-truth key repo facts it relies on.

● Read spec.md
  │ docs/automation/specs/issue-0033-true-token-level-streaming-transcription-streami/spec.md
  └ L1:60 (60 lines read)

/ Search (glob)
  │ "src-tauri/src/commands/*.rs"
  └ 11 files found

/ Search (glob)
  │ "src/lib/ai/*.ts"
  └ 11 files found

Spec file matches. Repo facts check out. Let me verify the provider contract and existing live-partial mechanism the spec extends.

● Read AIProvider.ts
  │ src/lib/ai/AIProvider.ts
  └ 57 lines read

/ Search (grep)
  │ "partial|livePartial|streaming" in *.ts (src)
  └ 1 file found

/ Search (glob)
  │ "src/lib/store/*.ts"
  └ 7 files found

Let me check whether the "live-partial" feature from #32 (which the spec treats as existing baseline/fallback) is actually present, since my first grep only hit `ollama.ts`.

/ Search (grep)
  │ "partial|stream|chunk|slice|interim" (src/overlay/Overlay.tsx)
  └ 20 lines found

/ Search (grep)
  │ "recording:partial|partial|interim" in *.{ts,tsx} (src/lib)
  └ 7 lines found

/ Search (grep)
  │ "partial|livePartial|live-partial|pseudo|chunk" (src)
  └ 8 files found

Key finding: the overlay's "streaming" (`streamingCleaned`/`streamingText`) is **cleanup-token** streaming, not transcription partials. Let me confirm whether the #32 mid-recording transcription-partial baseline actually exists, since the spec leans on it as the fallback.

/ Search (grep)
  │ "chunk|partial|slice|interim|ondataavailable|timeslice" (src/lib/audio.ts)
  └ 4 lines found

/ Search (grep)
  │ "chunk|partial|interim|transcribePartial|slice" (src/lib/ai/index.ts)
  └ 5 lines found

/ Search (grep)
  │ "recording:partial|transcribe.*partial|partialTranscript|interimTranscript" (src)
  └ No matches found

I've ground-truthed the spec against the repo. Findings below.

## Verification
- Spec file exists and matches; structure is complete (objective, 11 acceptance criteria, file list, phased plan, task breakdown with verify commands, security/privacy, boundaries, open questions).
- Repo facts are accurate: `AIProvider.ts`, `index.ts`, `localWhisper.ts`, `parakeet.ts`, `ollama.ts`, and Rust `local_whisper.rs`/`parakeet.rs`/`paste.rs` all exist.
- **However**: the spec's stated baseline — "existing chunked live partials from #32" as the default fallback — does **not** appear to exist in this codebase. The overlay's `streamingCleaned`/`streamingText` is *cleanup-token* streaming (LLM step), and `audio.ts` `chunks` are just MediaRecorder buffer parts assembled into one final Blob. No mid-recording transcription-partial path (`recording:partial`, `transcribePartial`, etc.) is present.

## Findings

**NON-BLOCKING (advisory)**
1. **Inaccurate baseline premise.** The "fallback = #32 chunked pseudo-streaming" framing doesn't match the current repo (no live transcription partials found). This does **not** change the deliverable: "opt-in, non-regressive, fall back to existing behavior" is identical whether the fallback is chunked partials or today's end-of-recording transcription. Implementer should confirm actual baseline in the Phase 1 spike and correct the wording.
2. **Terminology collision.** Repo already uses `streaming*` for cleanup-token streaming; new `streamingTranscription` settings/events risk confusion. Name to disambiguate.
3. **Contract shape.** `AIProvider` has no `capabilities` field today and `cleanup()` already returns `AsyncIterable<string>`. Prefer reusing the repo's existing async-iterable/event + SSE-parse patterns over a divergent callback interface.
4. **Audio transport perf.** Per-frame `Float32Array` over Tauri IPC to a Rust sidecar may be costly; consider Rust-side capture (cpal) or frame batching. Spike territory.
5. **Binary-dependency tension.** The feature likely needs a new streaming sidecar, which is on the "Ask First" list — cleanly handled by the spec's option 3 (ship infra + guarded/mocked backend, defer the real binary to maintainer sign-off). Land Phase 2 infra separately from Phase 3 engine integration to keep PRs reviewable.

**BLOCKING**: none. Security/privacy handling is thorough (no shell spawn, explicit-arg exec, path/arg validation, child-process termination on stop/cancel/close/shutdown, session-ID validation against stale events, no transcript/audio logging). It's local-only, opt-in, disabled by default, no schema/cloud changes — low blast radius, and remaining unknowns are routine spike decisions.

The one factual gap is recoverable during implementation and will be caught by the spike + downstream PR review/verification. It doesn't make the spec build the wrong thing.

SPEC_REVIEW_DECISION: proceed
