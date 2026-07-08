# Verbatim AI — Improvement Plan (2026-07)

Five workstreams, each documented in its own file with current-state analysis,
design, concrete implementation steps (with file paths), and acceptance
criteria. Written so any model/engineer can pick up a workstream cold.

| # | Area | Doc | Effort | Priority |
|---|------|-----|--------|----------|
| 1 | Fast setup with defaults ("Quick start") | [01-quick-setup.md](01-quick-setup.md) | M | High |
| 2 | Menu/IA simplification + settings search | [02-settings-ux.md](02-settings-ux.md) | M–L | Medium |
| 3 | Single-key hotkey incl. macOS `fn` | [03-single-key-hotkey.md](03-single-key-hotkey.md) | L (Rust) | High |
| 4 | Hotkey→listening latency + general perf | [04-performance-latency.md](04-performance-latency.md) | S–M | **Highest** |
| 5 | Security & privacy review + local-only guarantee | [05-security-privacy.md](05-security-privacy.md) | M | High |

## Suggested sequence

1. **04 quick wins** — reorder the recording hot path so audio capture starts
   the instant the hotkey fires (fixes the ~1 s delay in `todo.md` §2). Small
   diff, biggest user-perceived gain.
2. **05 hygiene items** — stop logging transcripts to the console; they're a
   privacy leak and cost nothing to remove.
3. **01 Quick start** — add a fast path through onboarding.
4. **03 `fn` key** — native macOS event-tap work; independent of the rest.
5. **02 IA + search** — best done after 01/05 settle where settings live.

## Status (updated as work lands)

- [x] Plan documented (this directory)
- [x] 04: hot-path reorder — audio starts before overlay chrome (see 04 §Fix 1–2)
- [x] 05: transcript console logging gated to dev builds
- [x] 01: Quick-start path in onboarding (defaults, 3 screens)
- [x] 03: `fn` key support — CGEventTap in `src-tauri/src/commands/fn_hotkey.rs`,
      sentinel spec `"Fn"` in `set_hotkey`, recorder chip + Input Monitoring
      permission flow. Untested on hardware: needs a manual pass of the doc-03
      test matrix (permission grant/relaunch, emoji-picker conflict).
- [x] 02: settings registry (`src/lib/settingsRegistry.ts`) + Cmd+K palette
      (`src/components/CommandPalette.tsx`) + tab/row deep-linking with flash
      in `Settings.tsx` — verified in-browser. Steps 4–5 (tab regroup into 4
      task-oriented tabs, Account-into-Settings merge) remain as follow-ups.

## Key facts discovered during analysis (save re-derivation)

- Onboarding is **13 steps** in one file: `src/routes/onboarding/Onboarding.tsx`.
- The recording hot path is fully **serial**: mode resolve → capture target
  window → overlay resize → position → show → wait ready → emit → *then*
  `getUserMedia` (300–1000 ms cold) inside `src/overlay/Overlay.tsx`.
- Single-key hotkeys already half-exist on the TS side
  (`src/lib/hotkey.ts` `isSingleKeySpec`/`usesHoldToTalk`), but `fn` can never
  arrive via `tauri-plugin-global-shortcut` — it needs a native macOS
  flags-changed event tap (see doc 03).
- `src/overlay/Overlay.tsx` logs full raw + cleaned transcripts with
  `console.info` — privacy leak.
- Supabase Edge Functions require real user JWTs and rate-limit Azure proxy
  calls; raw baked-in anon-key bearer calls are rejected (see doc 05).
