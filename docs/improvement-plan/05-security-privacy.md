# 05 — Security & Privacy Review

Goal: the user can *verify* nothing leaves their machine in local mode, and
opting into cloud is an explicit, informed act.

## Findings (ordered by severity)

### F1 — Transcripts logged to console  ✅ fixed
`src/overlay/Overlay.tsx` logged full raw + cleaned text via `console.info`,
and `runPipeline` relays error stacks. WebView consoles persist in devtools
buffers and can end up in OS logs. **Fix:** gate all transcript-content
logging behind `import.meta.env.DEV`. Audit repo-wide:
`grep -rn "console\.\(info\|log\|debug\)" src/ | grep -i "raw\|cleaned\|transcript\|text"`.

### F2 — Edge Functions accept the anon key (`--no-verify-jwt`) ✅ fixed
Anyone extracting `VITE_SUPABASE_ANON_KEY` from the shipped bundle could call
`transcribe`/`cleanup` and burn Azure quota. **Fix:** Edge handlers now require
a real Supabase user JWT (including anonymous sign-ins for local app mode),
reject raw anon-key bearer calls, enforce DB-backed per-user/per-IP rate
limits, and cap body/audio/prompt sizes. Deploy functions with default JWT
verification enabled.

### F3 — No user-visible "where does my data go" signal  ✅ done
The core ask. See "Privacy indicator" below. Implemented:
`src/lib/privacyStatus.ts` (resolved per-mode), `PrivacyCard` on Home
(local/mixed/cloud variants + "Change" deep-link), shield/cloud glyph
on the recording pill. Browser-verified for cloud and local variants.

### F4 — Windows: `--use-fake-ui-for-media-stream`
`src-tauri/src/lib.rs` auto-grants **any** media prompt in the WebView
(mic *and camera*) to skip the Chromium prompt. Acceptable trade-off, but
document it, and prefer scoping if WebView2 ever allows per-permission
policy. macOS is unaffected (WKWebView honors the OS TCC prompt).

### F5 — Ollama guidance encourages `OLLAMA_ORIGINS=*`  ✅ fixed (copy scoped to tauri origins)
Onboarding copy suggests a wildcard origin, which opens the user's Ollama to
*any* website via drive-by requests. Recommend the specific origin instead
(`OLLAMA_ORIGINS=tauri://localhost,http://localhost:*` — verify exact origin
the webview sends) and update the copy in `Onboarding.tsx` + Settings.

### F6 — Data-at-rest  🟡 retention setting done; window-title opt-out still open
Transcripts (history) and all settings live in plain `localStorage`
(`sw.*` keys) and in Supabase in cloud mode. Window titles + exe names are
attached to history rows — titles can contain sensitive content (document
names, email subjects). Actions:
- Add "history retention" setting (forever / 30d / 7d / off) — was in
  plan.md §9.8 but never built.
- Consider dropping `app_window_title` from persisted history (keep exe
  only) or making it opt-in.

### F7 — Update/telemetry endpoints
Even in "local" AI mode the app talks to: Supabase (edge functions in cloud
AI mode, auth/sync in cloud app mode), the updater endpoint (GitHub
releases), and model-download hosts (HuggingFace/GitHub) on demand. True
"nothing leaves the machine" claims must scope to *dictation content*, not
all traffic. The indicator (below) should say exactly that.

## Feature: Privacy indicator ("Local" / "Cloud" badge)

Single derived status, computed in one place (`src/lib/privacyStatus.ts`):

```
transcription: cloud | local   (getAiProviderKind)
cleanup:       cloud | local | skipped  (getCleanupProviderKind, skipCleanup/AI-improve-off)
⇒ overall: "fully-local" | "mixed" | "cloud"
```

Surfaces:
1. **Home page hero**: shield card — "Your voice never leaves this Mac"
   (fully-local) vs. "Audio is sent to Verbatim cloud for transcription"
   (with a "make it local" link → Settings AI tab).
2. **Recording pill**: tiny cloud/shield glyph next to the mode chip so the
   signal exists at the moment of speaking.
3. **Onboarding quick-start summary** (doc 01) states the default plainly.
4. Copy must carve out F7: "App updates and optional sync still use the
   network."

Per-mode overrides matter: a Mode can override providers (`getActiveProvider(mode)`),
so the pill's badge must be computed from the *resolved* provider pair for
the active mode, not the global setting.

## Recommended order

1. F1 (done) → F5 (done) → F3 (done) → F2 anonymous sign-ins (done) →
   F6 retention setting → F4 documentation note.

## Acceptance criteria

- Dev-only transcript logs; release builds emit no dictation content to any
  log/console.
- Home + pill show correct locality badge for all provider combos, including
  per-mode overrides.
- Edge functions reject unauthenticated abuse (or at minimum rate-limit) with
  no UX regression for local-mode users.
- A history retention option exists and prunes on boot.
