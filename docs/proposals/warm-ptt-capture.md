# Warm push-to-talk capture (near-zero-latency `fn` hotkey)

Design of record. Synthesized from a 3-model design council (GPT-5.5, Gemini
3.1 Pro, Claude Opus 4.7) comparing Verbatim AI against the open-source app
Handy. Clean-room: design-level adoption only, no Handy code copied.

## Problem

Handy's `fn` push-to-talk wakes recording with near-zero latency and stays on
until release. Ours lags because the recording hot path is JS-gated and opens
the mic on demand:

`fn` CGEventTap (Rust) → emit `hotkey:down` to the **main** window →
`await resolveModeAtPress()` (`get_active_window` IPC) → `startRecording()` →
`await waitForOverlayReady()` → cross-window `emit('recording:start')` →
**overlay** window → Web Audio `getUserMedia` (opens the mic on demand).

Before the first audio sample we pay an IPC round-trip + a getUserMedia mic
open (100–300 ms, warm only briefly after a prior recording) + an overlay-ready
wait + a cross-window hop. Handy pays ~none of this: a warm cpal stream always
feeds a ring buffer (device/config cached), key-down just starts consuming it,
and the webview is never on the hot path.

Measured target: press→first-sample from ~400–1200 ms cold / ~100–300 ms warm
today → ~50–200 ms cold / ~5–20 ms warm.

## Locked decisions (council consensus)

1. **Warm cpal engine in Rust.** A long-lived `NativeAudioEngine` worker thread
   owns the non-`Send` `cpal::Stream` and continuously fills a ring buffer
   (~1 s, 16 kHz mono f32). Device/config cached by label. Start/stop are
   *consumption markers*, not stream open/close. Every level/frame/PCM result
   carries a monotonic `session_id`. Extends the existing
   `src-tauri/src/commands/native_audio.rs`.
2. **Pre-roll ≤ 500 ms (default 250 ms), low-latency mode only.** On start,
   snapshot the last N ms from the ring buffer so onsets aren't clipped, and
   consume the in-flight cpal callback chunk. Pre-roll is a rolling pre-record,
   so it is **disabled unless low-latency mode is on**, and hard-capped at
   500 ms (privacy).
3. **Mic lifecycle default = on-demand + lazy close (~45 s idle).** The mic
   opens on first use and closes after idle, so the macOS orange indicator
   drops when not dictating. **Never always-on by default.**
4. **Opt-in "Low-latency mode (mic stays on)".** Persistent warm stream +
   pre-roll, behind `sw.audio.lowLatencyMode` (default off), with explicit
   in-UI copy that the mic indicator stays on.
5. **Rust owns audio bounds; JS owns orchestration.** Key-down (fn tap +
   non-fn shortcut) calls a direct Rust-to-Rust `notify_ptt_down/up` on the
   coordinator **before** emitting to JS, so capture (and pre-roll snapshot)
   starts immediately. JS then resolves mode, shows the overlay, and runs
   transcription — all off the audio hot path. The overlay is presentational.
6. **`get_active_window` off the critical path.** It's only needed for the
   paste target + mode routing, not to start audio. Resolve it concurrently
   with overlay show, after capture has started.
7. **`fn` CGEventTap robustness.** Handle `kCGEventTapDisabledByTimeout` /
   `ByUserInput` by re-enabling the tap, resetting the down flag, and emitting
   a synthetic `hotkey:up` (+ stop) if it was down.
8. **Overlay parity, Web Audio fallback preserved.** Native emits
   `native_audio:level` / `native_audio:frame` **only while Recording**
   (suppressed when warm/idle), session-filtered. The `AudioController`
   contract is unchanged. With `sw.audio.nativeCapture` off, the Web Audio path
   is byte-for-byte untouched.

## Feature flags (localStorage `sw.*`)

| Flag | Default | Meaning |
|------|---------|---------|
| `sw.audio.nativeCapture` | off | Use the native cpal capture path |
| `sw.audio.lowLatencyMode` | off | Keep the warm stream persistent + enable pre-roll (mic indicator stays on) |
| `sw.audio.preRollMs` | 250 | Pre-roll length, clamped 0–500, only applied in low-latency mode |

## UI redesign (hotkey selector)

Current confusion: three affordances to set one shortcut (capture button + loose
"Use fn" / "Use right ⌘" buttons) plus a separate push-to-talk switch that is
auto-disabled/forced for single keys with conditional copy.

Simplify to: (a) one recorder control + a compact **"Single key ▾"** menu
(fn, right ⌘, F-keys); (b) replace the disabled PTT switch with a clear mode
line — single keys show a fixed "Hold to talk", combos show a real
"Hold / Toggle" choice; (c) a "Low-latency mode" toggle with the mic-indicator
warning.

## Tracks & waves

Wave 0 (scaffold): flags in `preferences.ts`, perf log helper, this doc.

Wave 1 (parallel, disjoint files):
- **T-ENGINE** — `NativeAudioEngine`: warm stream, ring buffer, pre-roll,
  session ids, idle close, new commands. `native_audio.rs`.
- **T-FNTAP** — CGEventTap disabled-event recovery. `fn_hotkey.rs`.
- **T-MODEPATH** — `get_active_window`/mode resolution off the critical path +
  press→first-sample instrumentation. `hotkey.ts`, `recording-bridge.ts`.
- **T-UI** — hotkey selector redesign. `HotkeyRecorder.tsx`, `Settings.tsx`,
  `preferences.ts`.

Wave 2 (depends on Wave 1):
- **T-COORD** — Rust-first hot path: `notify_ptt_down/up` from `fn_hotkey.rs` +
  `hotkey.rs` into the engine (depends on T-ENGINE, T-FNTAP).
- **T-JSWIRE** — JS consumes the warm engine: `take_recording` on stop, cancel
  drops the buffer, stop invoking per-press `start_native_capture`.
  `nativeAudio.ts`, `recording-bridge.ts` (depends on T-ENGINE).
- **T-OVERLAY** — session-filtered / state-gated level+frame in the overlay.
  `Overlay.tsx` (depends on T-ENGINE).
- **T-SETTINGS** — low-latency + pre-roll settings UI with mic-indicator copy.
  `Settings.tsx` (depends on T-UI, flags).

Wave 3: **T-VERIFY** — cargo build, tsc, lint, vitest, non-regression (Web
Audio default + Windows), perf-log latency check; cross-model review + security
audit (pre-roll privacy, mic-indicator honesty).

## Acceptance criteria

- With all flags off: Web Audio path and Windows global-shortcut behavior are
  unchanged; all existing tests pass.
- With `sw.audio.nativeCapture` on: recording works via the warm engine; the
  overlay meter + live partials keep parity; mic closes after idle.
- With `sw.audio.lowLatencyMode` on: `fn` press→first-sample is near-instant
  and no onset is clipped (pre-roll); Settings clearly warns the mic stays on.
- `fn` never silently stops after a system tap-disable event.
- `get_active_window` is not awaited before capture starts.

## Non-goals / rejected

- Always-on mic as the shipping default (privacy / mic-indicator).
- Pre-roll > 500 ms or pre-roll while low-latency mode is off.
- Moving mode resolution / overlay rendering into Rust (keep the split).
- Removing the Web Audio fallback.
- Copying Handy source.
