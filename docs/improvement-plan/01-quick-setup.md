# 01 — Quick Start Onboarding

## Current state

`src/routes/onboarding/Onboarding.tsx` (~1,700 lines) runs a **13-step**
linear flow, hardcoded as numeric steps in `StepBody`:

0. Welcome · 1. Mic permission · 2. Sign-in status · 3. AI model picker
(cloud/whisper/parakeet + cleanup cloud/ollama, incl. runtime & model
downloads) · 4. Modes intro · 5. Hotkey + PTT + overlay position ·
6. Apps pick · 7. Tone per app · 8. Vocabulary · 9. History toggle ·
10. Preferences (autostart, theme) · 11. Generate · 12. Test/done.

State lives in `src/lib/store/useOnboarding.ts` (step index, picks, tones,
hotkey, ptt; `applyOnboarding()` creates modes + app mappings; `finish()`
sets the completion flag read by `isOnboardingComplete()`).

Problem: a new user must make ~10 decisions before dictating once. Only two
are truly load-bearing: **mic permission** (hard requirement) and
**cloud vs. local AI** (privacy choice we shouldn't silently default).

## Design

At the Welcome step, offer two paths:

- **"Quick start" (primary CTA)** — 3 screens total:
  1. Welcome (choose path)
  2. Mic permission (unavoidable)
  3. "You're set" — shows the 4 defaults applied as a compact summary
     (hotkey, cloud AI, history on, default modes), each with a small
     "change" link that deep-links to the relevant Settings tab later.
     Primary CTA: "Try it now".
- **"Customize setup"** — the existing 13-step flow, unchanged.

### Defaults applied by Quick start

| Setting | Default | Where it's persisted today |
|---|---|---|
| Hotkey | platform default from `src/lib/hotkey.ts` (`Control+Shift+Space` mac, `CommandOrControl+Space` win) | `saveHotkeyConfig` + `applyHotkey` |
| Push-to-talk | on | `saveHotkeyConfig` |
| AI provider | cloud transcribe + cloud cleanup | `setAiProviderKind("cloud")`, `setCleanupProviderKind("cloud")` |
| Modes | built-ins only (already seeded) | no-op |
| App mappings | none (default mode everywhere) | no-op |
| History | on | `setHistoryDisabled(false)` |
| Overlay position | bottom-center | `setOverlayPosition` |
| Theme | system | `useTheme` |
| Autostart | **do not silently enable** — offer as a checkbox on the final screen, default checked is acceptable since it's visible | `setAutostart` |

Cloud default is fine **as long as** the final screen states plainly
"Audio is sent to our cloud for transcription — switch to fully-local in
Settings → AI model" (ties into doc 05's privacy indicator).

## Implementation steps

1. **Refactor steps to named IDs** (mechanical, do first):
   in `useOnboarding.ts` replace the numeric `step` with
   `type StepId = "welcome" | "mic" | ... ` plus a `path: "quick" | "custom"`
   field; derive the step list from the path:
   `QUICK_STEPS = ["welcome", "mic", "done"]`,
   `CUSTOM_STEPS = [...all 13]`. `next()`/`back()` walk the active list.
   Keep a migration: persisted numeric step → equivalent named step.
2. **Welcome step**: two CTAs. "Quick start" sets `path="quick"`, applies
   the defaults table above (a new `applyQuickDefaults()` in
   `useOnboarding.ts`), and advances. "Customize setup" sets `path="custom"`.
3. **Done step (quick variant)**: summary card of applied defaults +
   autostart checkbox + "Try it now" (calls `finish()`, navigates `/`).
4. `ProgressDots` reads the active step list length instead of `TOTAL_STEPS`.
5. **Re-run onboarding** (Settings → Advanced) should land on Welcome and let
   the user pick either path again.

## Acceptance criteria

- New install → dictating in ≤ 3 clicks after mic permission.
- Quick path never downloads models or requires sign-in decisions.
- Custom path behaves exactly as before.
- Quick-start summary discloses cloud processing and links to switch local.

## Risks / notes

- The step refactor touches every step component's `next`/`back` wiring —
  keep it a pure rename-and-index change, no behavior edits, in its own commit.
- `applyOnboarding()` with zero picks currently creates 0 modes/0 mappings —
  already safe to call (or skip) on the quick path.
