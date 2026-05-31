# TODO

## 1. Enforce single-instance window
**Problem:** If Verbatim AI is already open and the user launches it again, a second identical window opens, creating clutter.

**Goal:** Prevent multiple instances. When a launch is attempted while the app is already running, focus and bring the existing window to the foreground instead of opening a new one.

**Acceptance criteria:**
- Launching the app a second time does not create a new window.
- The existing window is restored (if minimized) and brought into focus.
- Works on all target platforms.

---

## 2. Eliminate transcription start delay
**Problem:** After pressing the transcription hotkey, there is a ~1 second delay before recording/transcription actually begins, which annoys users even though the voice animation already appears.

**Goal:** Begin recording and transcribing the instant the hotkey is pressed — no perceptible delay.

**Acceptance criteria:**
- Audio capture starts immediately on hotkey press.
- No audio is lost at the start of a recording.
- Recording and the visual animation do NOT need to be in sync. Keep the existing popup animation as-is, but ensure audio is already being captured (the hotkey is pressed) while that animation plays (recording must not wait for the animation to finish).

---

## 3. Support single-key hold-to-talk hotkey on macOS
**Problem:** On macOS users want a simpler trigger than a key combination.

**Goal:** Allow configuring transcription to a single key that works as press-and-hold (hold the key to record, release to stop).

**Acceptance criteria:**
- A single key can be assigned as the transcription trigger on macOS.
- Holding the key records; releasing it stops.
- Configurable from Settings.