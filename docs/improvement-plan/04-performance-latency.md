# 04 — Latency & Performance

Latency is the product (plan.md §1). The complaint (todo.md §2): ~1 s between
hotkey press and actual listening.

## Hot-path autopsy (hotkey down → audio flowing)

All of this is **serial** today:

| # | Step | Where | Cost (typical) |
|---|------|-------|----------------|
| 1 | `hotkey:down` event → JS | Rust plugin → main window | ~0 |
| 2 | `resolveModeAtPress()` → `get_active_window` invoke | `src/lib/modeResolver.ts` | 5–30 ms |
| 3 | `capture_target_window` invoke | `src/lib/recording-bridge.ts` | 5–20 ms |
| 4 | overlay `setSize` + `positionOverlay` (cursor pos + monitor lookups, 3–5 IPC calls) | recording-bridge | 10–40 ms |
| 5 | `overlay.show()` | recording-bridge | 10–50 ms |
| 6 | `waitForOverlayReady()` | recording-bridge | ~0 after first run |
| 7 | `emit("recording:start")` → overlay | recording-bridge | ~0 |
| 8 | overlay `start()`: `await w.show()` (redundant with #5) | `src/overlay/Overlay.tsx` | 5–20 ms |
| 9 | **`getUserMedia` + `new AudioContext` + `MediaRecorder.start()`** | `src/lib/audio.ts` | **300–1000 ms cold** |

Step 9 dominates. Steps 2–8 add ~50–150 ms of avoidable serialization in
front of it.

## Fix 1 — start audio first, chrome after (small diff, ship first)

Reorder `startRecording` in `src/lib/recording-bridge.ts`:

```
await waitForOverlayReady();
emit("recording:start", …)            // overlay begins getUserMedia NOW
then, concurrently (not awaited before the emit):
  capture_target_window → setSize/position → show
```

Ordering constraints that must hold:
- `capture_target_window` **before** `overlay.show()` (paste-target capture,
  plan §14) — keep those two ordered *relative to each other*, but neither
  needs to precede the emit: the overlay window exists hidden and can run
  `getUserMedia` without being visible.
- In `Overlay.tsx#start`, drop the `await w.show()` (bridge shows the window)
  and call `startRecording(...)` immediately.
- `stopRecording` racing a still-initializing start: `stop()` already
  null-checks `controllerRef`; add a "starting" promise so a fast
  press-release stops the controller once it materializes instead of leaking
  a live mic. **(Important correctness detail.)**

Also run step 2 (`resolveModeAtPress`) in parallel with the bridge call in
`src/lib/hotkey.ts` — the overlay only needs the mode for the *pipeline*,
not for capture. (The emit payload carries mode name/id; either pre-resolve
in parallel and emit after, or move resolution to the overlay side.)

## Fix 2 — warm mic (bigger win, opt-in)  ✅ option 2 implemented

Landed as a 30 s keep-warm cache in `src/lib/audio.ts` (`takeWarm` /
`parkWarm` / exported `releaseWarmMic` escape hatch): after a dictation
ends the stream + AudioContext are parked and reused if the next one
starts within the window, keyed by device id (device switch = fresh
acquire). The OS mic indicator stays on for the window — by design.
Option 3 (always-warm setting) remains unimplemented.

`getUserMedia` cold start is the real 300–1000 ms. Options, in order:

1. **Pre-acquire on hotkey-down is already Fix 1.** Beyond that:
2. **Keep-warm window**: after a recording stops, keep the `MediaStream` and
   `AudioContext` alive for N seconds (e.g. 30 s) and reuse. Consecutive
   dictations become instant. Cost: mic-in-use indicator stays on for N s.
3. **Always-warm setting** ("Instant listening — keeps the microphone open;
   the orange mic indicator will stay on"): persistent stream acquired at
   overlay boot. Default **off** (privacy optics; doc 05's indicator must
   reflect it).

Implement as a small stream-cache module in `src/lib/audio.ts`:
`acquireStream(deviceId)` returns cached-or-fresh; `releaseStream(afterMs)`.
MediaRecorder/AnalyserNode are cheap — only the stream/context need caching.

## Fix 3 — collapse bridge IPC (optional, after 1–2)

One Rust command `prepare_overlay(position_pref)` doing capture-target +
resize + position + show in a single round-trip, replacing 5–7 JS-side IPC
calls. Only worth it if measurement (below) still shows >30 ms here.

## Measure, don't guess

Add lightweight instrumentation first:
`performance.mark` at hotkey-down (main), recording-start received (overlay),
`getUserMedia` resolved, first `dataavailable`. Log a single summary line
gated behind a `sw.debug.perf` localStorage flag. Keep it permanently — it's
how regressions get caught.

## Beyond the hot path (backlog, lower priority)

- **Pipeline tail latency**: transcription+cleanup are serial network calls;
  cleanup already streams. Consider starting transcription upload while
  recording (chunked/streaming) — large change, needs Edge Function support.
- **`skipCleanup` fast path** already exists per-mode; surface it better
  ("Instant mode") since it halves round-trips.
- **Startup**: `hydrateAll()` blocks on network in cloud mode? Verify it
  renders from localStorage cache first (stores claim write-through caching).
- **Bundle**: Onboarding (1,700 lines) and Settings (1,415) are in the main
  chunk; lazy-load routes via `React.lazy` — helps overlay window boot too
  since overlay entry should not pull main-window routes (verify
  `vite.config.ts` chunking).
- Waveform renders at 60 fps via rAF — fine, but ensure it stops when state
  ≠ recording (check `RecordingPill`).

## Acceptance criteria

- Perceived press→listening < 150 ms warm, < 400 ms cold (measured by the
  instrumentation above).
- No lost audio at the start of an utterance (speak instantly on press).
- Fast press-release (< 200 ms hold) never leaks a live mic stream.
- Overlay animation may lag audio start — that's by design (todo.md §2).
