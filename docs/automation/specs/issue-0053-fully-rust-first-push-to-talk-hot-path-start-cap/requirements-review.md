# Requirements review for issue #53

Status: clear
Issue input SHA: c065d5f430bcba40f604e8be31bc4401f3346d2478244741b333594ecc461af8

## Summary

Requirements are clear enough to draft a spec without a human requirements gate.

## Findings

- Issue is well-structured (problem/approach/acceptance context present).
- Issue includes concrete diagnostic evidence.

## Questions / blockers

- None.

## Next action

Proceed to spec drafting. Implementation still requires spec review and approval.

## Original issue

Follow-up to #51 (near-zero-latency push-to-talk). Design context: `docs/proposals/warm-ptt-capture.md`.

## Context
#51 landed the warm cpal engine + a JS-orchestrated warm-session capture flow, and #52 made native "Fast" capture the default. That removes the dominant latency (the on-demand `getUserMedia` mic open) — push-to-talk now starts on an already-warm stream. This issue is the **last slice** of latency.

## What's left: make the hot path fully Rust-first
Key-down still routes through the webview to start the session: `fn` CGEventTap → emit `hotkey:down` → main-window JS → `start_native_session`. The council's ideal is to start capture in Rust before any JS runs.

- Add a sync `notify_ptt_down/up` path on the native engine (`src-tauri/src/commands/native_audio.rs`) callable directly from the tap callback + the global-shortcut handler; store the pre-roll config at arm time so the hot path knows it.
- Wire `src-tauri/src/commands/fn_hotkey.rs` + `hotkey.rs` to call it **before** emitting `hotkey:down`/`up`; include the `sessionId` in the event so JS adopts the already-started session instead of starting its own.
- JS stops double-starting the session (it just shows the overlay, resolves the mode, and `take_native_recording` on stop).
- Decouple `get_active_window` / mode resolution from the audio start (minor now that the mic is warm, but do it here).

## Also: small engine nits deferred from the #51 review
- **N4** — pre-size the session buffer for long recordings so the realtime cpal callback doesn't pay amortized `Vec` growth.
- **S2** — emit a `native_audio:error` event (with `sessionId`) on mid-session device loss so the overlay can surface it.

## Acceptance
- `fn` press → first captured sample with **no JS on the critical path**.
- No regression to Standard/WebAudio or Windows; overlay meter + live partials still work.
- Non-macOS builds unaffected.

