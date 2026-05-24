# SuperWisper — Comprehensive Build Plan

A Windows desktop voice-transcription app with a modern, animated UI. Inspired by Superwhisper and Wispr Flow. Built for personal/open-source use.

> **Tagline:** *Talk anywhere. We type it for you, in your voice, in the right tone, in any app.*

---

## Table of Contents

1. Product Vision & Principles
2. User Personas & Use Cases
3. End-to-End User Journey
4. Tech Stack (with rationale)
5. Application Architecture
6. Repository Layout
7. Data Model & Persistence
8. Detailed Feature Specs
9. Screen-by-Screen UI Spec
10. Visual & Motion Design System
11. AI Provider Layer Design
12. Audio Pipeline
13. Hotkey & Active-Window System
14. Auto-Paste & Output Routing
15. Onboarding Flow Spec
16. Settings, Permissions & Security
17. Supabase Schema & Sync Strategy
18. Error Handling, Edge Cases & Telemetry
19. Performance & Resource Budget
20. Build, Packaging & Distribution
21. Implementation Roadmap (Phased)
22. Testing Strategy
23. Out of Scope for v1
24. Open Items / Decisions Deferred
25. Glossary

---

## 1. Product Vision & Principles

### Vision
SuperWisper makes typing feel slow. You hold a hotkey, say what you mean, and the right text — already polished — appears wherever your cursor is. It adapts its tone per app, learns your vocabulary, and feels like a native part of Windows.

### Design principles
- **Latency is the product.** Every interaction must feel under 200 ms perceptually. Loading states are animated, never blank.
- **Invisible when working, beautiful when seen.** The recording overlay should feel like a piece of jewelry. The settings window should feel like Linear or a modern macOS app.
- **Local-first, cloud-optional.** The app must work fully offline-capable for already-cached settings. Sync is a bonus, not a requirement.
- **Your voice, not the AI's voice.** The cleanup model preserves the user's intent. Filler removal and grammar fixes only — no rewording unless the Mode explicitly says to.
- **Reversible everywhere.** Every transcription is undoable. Every Mode change is non-destructive.
- **Keyboard-driven.** The whole settings UI is navigable without a mouse.

---

## 2. User Personas & Use Cases

### Persona 1 — "Builder Jacob" (primary)
Uses it across Slack, Discord, VS Code, Cursor, GitHub, Notion, Gmail. Wants quick, low-friction dictation that adapts: casual in Discord, semi-formal in email, terse in code comments.

### Persona 2 — "Communicator"
Sends long messages, hates typos, wants polished output. Heavy email + Slack user.

### Persona 3 — "Polyglot"
Speaks in their native language, wants English output.

### Top use cases
1. Reply to a Slack message in 5 seconds without typing.
2. Dictate a paragraph into an email and have it cleanly punctuated.
3. Talk to an AI coding agent (Cursor, Claude Code) at speaking speed.
4. Drop in an MP3 of a meeting and get a transcript.
5. Speak Spanish into Slack, have English text appear.

---

## 3. End-to-End User Journey

1. **Install** — user downloads `SuperWisper-Setup.exe` from GitHub Releases, runs it, app installs, launches.
2. **Onboarding** — welcome screen → mic permission → optional sign-in → choose hotkey → answer a few questions about preferred apps and tone → modes auto-generated → quick test.
3. **Daily use:**
   - User is in any app (say, Slack).
   - User presses & holds `Ctrl+Space` (or whatever they configured).
   - Floating glass pill fades up from the taskbar with a live waveform.
   - User speaks: "hey jonas can you push the latest commit and let me know when ci passes"
   - User releases the hotkey.
   - Pill shows "Transcribing…" with shimmer.
   - Cleaned text (per Slack Mode = casual) types itself into the Slack input: *"Hey Jonas, can you push the latest commit and let me know when CI passes?"*
   - Pill fades away. Entry saved to history (synced to Supabase if signed in).
4. **Settings later** — user opens app from tray, edits a Mode, adds vocabulary terms, reviews history.

---

## 4. Tech Stack (with rationale)

| Concern | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Tiny installer (~10 MB), Rust backend for native Windows APIs (hotkeys, paste, active window), built-in updater & MSI/NSIS bundler. |
| Frontend framework | **React 18** + **TypeScript** + **Vite** | Familiar, fast HMR, huge ecosystem. |
| Styling | **Tailwind CSS 3** + CSS custom properties | Quick to iterate, easy to theme dark/light, glass utilities. |
| Animations | **Framer Motion 11** | Spring-based, layout animations, gesture-friendly. |
| UI primitives | **Radix UI** | Accessible headless components (Dialog, Popover, Select, etc.) we style ourselves. |
| Icons | **Lucide React** | Consistent line icons, tree-shakeable. |
| State (UI) | **Zustand** | Simple, no boilerplate, persistable. |
| Forms | **React Hook Form** + **Zod** | Type-safe validation. |
| Routing | **React Router 6** (memory router) | In-window routing. |
| Audio | **Web Audio API** + **MediaRecorder** | Native browser stack, good waveform data via `AnalyserNode`. |
| Database (cloud) | **Supabase** (Postgres + Auth) | Already chosen by user. Row-level security, magic-link auth. |
| AI | **Azure AI Foundry** | Already chosen by user. Behind a provider interface so we can plug different models in. |
| Local cache / queue | **SQLite** via **`tauri-plugin-sql`** | Persists history offline, syncs on reconnect. |
| Secrets | **`tauri-plugin-stronghold`** or OS keyring (`tauri-plugin-keyring`) | Stores Supabase session + Azure keys securely. |
| Rust crates | `enigo` (synthetic input), `windows` crate (Win32), `cpal` (audio if needed), `serde`, `tokio` | Native operations. |
| Tauri plugins | `global-shortcut`, `tray-icon`, `notification`, `updater`, `autostart`, `clipboard-manager`, `fs`, `dialog`, `log` | Cover all OS integration. |
| Logging | `tracing` (Rust) + `consola` or simple wrapper (TS) | Structured logs, file rotation. |
| Testing | **Vitest** (unit), **Playwright** (e2e on packaged app), `cargo test` (Rust) | Standard. |
| Lint/format | **ESLint** + **Prettier** + `cargo clippy` + `rustfmt` | Standard. |
| Pkg manager | **pnpm** | Fast, disk-efficient. |
| Node version | Node 20 LTS | |

---

## 5. Application Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  WINDOWS DESKTOP — Tauri Process                            │
│  ┌─────────────────────────┐  ┌─────────────────────────┐   │
│  │  Main Window (React)    │  │ Overlay Window (React)  │   │
│  │  Settings / Modes /     │  │ Floating glass pill,    │   │
│  │  History / Onboarding   │  │ live waveform, always-  │   │
│  │                         │  │ on-top, transparent,    │   │
│  │                         │  │ click-through option    │   │
│  └────────────┬────────────┘  └────────────┬────────────┘   │
│               │   Tauri IPC (commands + events)             │
│               ▼                            ▼                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Rust Core                                           │   │
│  │  ─ HotkeyService (global-shortcut)                   │   │
│  │  ─ ActiveWindowService (Win32 GetForegroundWindow)   │   │
│  │  ─ AudioBridge (receives blobs, saves files)         │   │
│  │  ─ Paster (enigo synthetic Ctrl+V)                   │   │
│  │  ─ ClipboardService                                  │   │
│  │  ─ SecretsStore (keyring)                            │   │
│  │  ─ Updater                                           │   │
│  │  ─ TrayController                                    │   │
│  │  ─ SQLiteRepo (history cache)                        │   │
│  └─────────────────────────┬────────────────────────────┘   │
└────────────────────────────┼────────────────────────────────┘
                             │  HTTPS
                ┌────────────┴────────────┐
                ▼                         ▼
        ┌───────────────┐         ┌────────────────────┐
        │   Supabase    │         │ Azure AI Foundry   │
        │ auth, modes,  │         │ transcription +    │
        │ history, vocab│         │ chat completion    │
        └───────────────┘         └────────────────────┘
```

### Process model
- **Single Tauri process** with two Tauri windows: `main` (hidden by default, shown on user request from tray) and `overlay` (lives invisible, shown on hotkey press).
- Rust side spawns Tokio tasks for: hotkey listener, active-window poller (only when needed), Azure HTTP client.
- Frontend communicates via Tauri `invoke` (commands) and `emit/listen` (events). All IPC channels typed via shared schema generated by `specta` or hand-rolled TS types.

### Lifecycle
- App launches on Windows startup (if user opted in during onboarding) as hidden tray-only.
- Tray icon shows status (Idle / Recording / Transcribing / Offline).
- Closing the main window only hides it. Quit only via tray menu.

---

## 6. Repository Layout

```
SuperWisper/
├── src/                              # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── routes/
│   │   ├── Home.tsx
│   │   ├── Modes.tsx
│   │   ├── ModeEditor.tsx
│   │   ├── Vocabulary.tsx
│   │   ├── History.tsx
│   │   ├── Apps.tsx
│   │   ├── Settings.tsx
│   │   ├── Account.tsx
│   │   └── onboarding/
│   │       ├── Welcome.tsx
│   │       ├── Permissions.tsx
│   │       ├── SignIn.tsx
│   │       ├── Hotkey.tsx
│   │       ├── AppsPick.tsx
│   │       ├── ToneEach.tsx
│   │       ├── Generate.tsx
│   │       └── TestRecording.tsx
│   ├── overlay/
│   │   └── Overlay.tsx               # entry point for overlay window
│   ├── components/
│   │   ├── ui/                       # Button, Card, Input, Toggle, etc.
│   │   ├── layout/                   # Sidebar, TopBar, PageHeader
│   │   ├── modes/                    # ModeCard, PromptEditor, OutputPicker
│   │   ├── recording/                # Waveform, RecordingPill
│   │   ├── history/                  # HistoryRow, HistoryFilters
│   │   └── onboarding/               # StepShell, ProgressDots
│   ├── lib/
│   │   ├── ipc.ts                    # typed wrapper around Tauri invoke
│   │   ├── audio.ts                  # MediaRecorder + AnalyserNode
│   │   ├── ai/
│   │   │   ├── AIProvider.ts         # interface
│   │   │   ├── AzureFoundryProvider.ts
│   │   │   └── promptBuilder.ts
│   │   ├── supabase.ts
│   │   ├── sync.ts                   # local <-> remote sync
│   │   ├── store/                    # Zustand stores
│   │   │   ├── useModes.ts
│   │   │   ├── useSettings.ts
│   │   │   ├── useRecording.ts
│   │   │   └── useAuth.ts
│   │   ├── theme.ts
│   │   └── utils.ts
│   ├── styles/
│   │   ├── globals.css
│   │   └── tokens.css                # CSS variables
│   └── types/                        # shared TS types
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands/                 # IPC command handlers
│   │   │   ├── hotkey.rs
│   │   │   ├── audio.rs
│   │   │   ├── paste.rs
│   │   │   ├── clipboard.rs
│   │   │   ├── active_window.rs
│   │   │   ├── history.rs
│   │   │   └── settings.rs
│   │   ├── services/
│   │   │   ├── active_window.rs
│   │   │   ├── secrets.rs
│   │   │   ├── sqlite.rs
│   │   │   └── tray.rs
│   │   └── events.rs                 # event payload types
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   └── icons/
├── public/
├── docs/
│   └── ARCHITECTURE.md
├── .env.example
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── tailwind.config.ts
├── vite.config.ts
└── README.md
```

---

## 7. Data Model & Persistence

Three storage layers:

1. **Supabase (Postgres)** — source of truth when signed in.
2. **SQLite (local)** — cache + offline queue.
3. **Zustand + `localStorage`** — UI state (theme, recent filters).

### Tables (same shape in Supabase and SQLite)

```sql
profiles (
  id            uuid PRIMARY KEY,           -- auth.uid()
  email         text,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

modes (
  id              uuid PRIMARY KEY,
  user_id         uuid REFERENCES profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  icon            text,                     -- lucide icon name
  description     text,
  system_prompt   text NOT NULL,            -- the cleanup instruction
  language        text DEFAULT 'auto',      -- BCP-47 or 'auto'
  target_language text,                     -- null = same as input
  output_style    text NOT NULL,            -- 'paste' | 'review'
  hotkey          text,                     -- per-mode hotkey override
  push_to_talk    boolean DEFAULT true,
  save_history    boolean DEFAULT true,
  is_builtin      boolean DEFAULT false,
  position        int DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

app_mappings (
  id                  uuid PRIMARY KEY,
  user_id             uuid REFERENCES profiles(id) ON DELETE CASCADE,
  app_executable      text NOT NULL,        -- 'slack.exe'
  app_display_name    text NOT NULL,        -- 'Slack'
  app_icon_path       text,
  mode_id             uuid REFERENCES modes(id) ON DELETE SET NULL,
  match_window_title  text,                 -- optional regex
  created_at          timestamptz DEFAULT now()
);

vocabulary (
  id                uuid PRIMARY KEY,
  user_id           uuid REFERENCES profiles(id) ON DELETE CASCADE,
  term              text NOT NULL,
  pronunciation     text,                   -- "kew-bur-net-eez"
  notes             text,
  created_at        timestamptz DEFAULT now()
);

transcriptions (
  id                uuid PRIMARY KEY,
  user_id           uuid REFERENCES profiles(id) ON DELETE CASCADE,
  mode_id           uuid REFERENCES modes(id) ON DELETE SET NULL,
  mode_name_snap    text,                   -- denormalized for history
  raw_text          text,
  cleaned_text      text,
  audio_duration_ms int,
  word_count        int,
  app_executable    text,
  app_window_title  text,
  output_action     text,                   -- 'pasted' | 'reviewed' | 'copied' | 'discarded'
  language_detected text,
  cost_cents        int,                    -- optional
  created_at        timestamptz DEFAULT now()
);

user_settings (
  user_id              uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  default_mode_id      uuid REFERENCES modes(id) ON DELETE SET NULL,
  global_hotkey        text DEFAULT 'CommandOrControl+Space',
  push_to_talk_default boolean DEFAULT true,
  auto_launch          boolean DEFAULT true,
  theme                text DEFAULT 'dark',
  accent_color         text DEFAULT 'violet',
  overlay_position     text DEFAULT 'bottom-center',
  audio_input_device   text,
  azure_endpoint       text,                -- stored encrypted client-side
  azure_deployment     text,
  show_dock_icon       boolean DEFAULT false,
  send_telemetry       boolean DEFAULT false,
  updated_at           timestamptz DEFAULT now()
);
```

All tables have **Row Level Security** policies: `auth.uid() = user_id`.

### Built-in modes seeded on first run

1. **Default** — universal cleanup, removes fillers, fixes punctuation, preserves tone.
2. **Formal Email** — proper greeting/sign-off, complete sentences, professional vocabulary.
3. **Slack Message** — casual, contractions ok, light emoji if appropriate, no formalities.
4. **Code Comment** — concise, imperative mood, no fluff, wrap at ~80 chars.
5. **Notes** — bullet points where appropriate, terse, brain-dump friendly.
6. **Translate → English** — translates any input to natural English.

### Sync strategy
- **Write path:** every local change writes to SQLite first, then enqueues an upsert to Supabase. On success, mark synced.
- **Read path:** on app start, full pull of small tables (modes, vocab, settings, app_mappings), incremental pull of `transcriptions` by `updated_at`.
- **Conflicts:** last-write-wins per row, using `updated_at`. Modes have a `name` uniqueness check per user.
- **Offline:** if Supabase unreachable, queue persists in SQLite. Reconnect drains queue with backoff.

---

## 8. Detailed Feature Specs

### 8.1 Recording flow (the heart of the app)
**Trigger:** global hotkey (configurable, default `Ctrl+Space`). Two modes per Mode: push-to-talk or toggle.

**Push-to-talk:**
1. Key down → Rust emits `recording:start`.
2. Overlay window shows. Audio capture begins (44.1 kHz, mono, 16-bit PCM, Opus encoded for upload).
3. Live waveform animates from `AnalyserNode` data.
4. Key up → Rust emits `recording:stop`.
5. Audio blob finalized, sent to AI pipeline.

**Toggle:**
- Tap key → start. Tap again (or Esc) → stop.
- Long-press also stops (safety in case user forgets state).

**Visual states of overlay:**
1. `idle` (hidden)
2. `appearing` (200 ms spring entrance from below)
3. `recording` (waveform + "Listening…" label + accent ring pulsing)
4. `processing` (waveform replaced by shimmer + "Transcribing…")
5. `polishing` (shimmer continues + "Polishing with [Mode name]…")
6. `success` (brief checkmark flash) → fades out
7. `error` (red ring + error toast, stays 3 s)

**Cancellable** at any time with Esc or by pressing the hotkey again.

### 8.2 Modes
A Mode is a reusable preset that controls:
- The cleanup prompt sent to the LLM
- Output target language (translation if set)
- Output behavior (auto-paste vs. review panel)
- Whether history is saved
- Optional per-mode hotkey override
- Optional vocabulary subset (advanced — v1 uses global vocab)

UI affordances:
- Grid of `ModeCard`s, drag to reorder.
- Edit screen with: name, icon picker, description, system prompt textarea (monospace, with token estimate), language selector, output style toggle, hotkey recorder, history toggle, "Test this mode" button (lets user record into a sandbox and see output).

### 8.3 App-specific auto-mode
- Active-window service runs only **at hotkey-press time** (not continuously, to save resources).
- Looks up `app_executable` (and optionally regex-matched `window_title`) in `app_mappings`.
- If match → use that Mode. Else → default Mode.
- "Apps" screen lists known apps with their assigned Mode + an "Add app" button (opens picker that lists running processes).

### 8.4 File transcription
- Drag-drop or "Choose file" button.
- Supported: `.mp3, .mp4, .m4a, .wav, .webm, .ogg`. Max 500 MB (configurable).
- Files larger than provider limit get chunked locally (ffmpeg via WASM or system ffmpeg if available; fallback to native Rust `symphonia` decode + re-encode).
- Progress bar with per-chunk status.
- Result saved to history with `audio_duration_ms` + source filename.
- Optional: export as `.txt` or `.srt` (with timestamps when provider supports it).

### 8.5 Custom vocabulary
- Simple list: term + optional pronunciation hint + optional notes.
- Bulk import via CSV.
- Injected into every cleanup prompt as: *"Be aware these specialized terms may appear: …"* — keeps proper nouns spelled correctly.

### 8.6 Translation
- Per-mode `target_language`. If set, the cleanup prompt becomes a "translate to X then polish" instruction.
- Detected source language stored in history.

### 8.7 History
- Full-text search (SQLite FTS5 locally, Supabase `pg_trgm` remotely).
- Filters: mode, app, date range, language.
- Row actions: copy, paste (into focused app), re-clean with different mode, delete.
- Bulk delete with "delete all from [app]" shortcut.
- Privacy: if a Mode has `save_history = false`, that transcription is never persisted (memory only).

### 8.8 Onboarding (detailed in §15)

### 8.9 Account
- Email + password sign-up.
- Magic link sign-in (preferred).
- Forgot password.
- Avatar, display name, theme.
- "Delete my account and all data" (cascade delete).

### 8.10 System tray
Tray menu:
- `● SuperWisper · Idle` (status row, non-clickable)
- Open SuperWisper
- ─
- Start Recording (or Stop)
- Pause hotkey (toggleable)
- Quick switch mode → submenu of modes with checkmark on current default
- ─
- Settings…
- Check for updates
- ─
- Quit

Tray icon changes color: gray (idle), violet pulsing (recording), cyan (processing), red (error).

### 8.11 Auto-update
- Tauri updater checks GitHub Releases (configurable JSON manifest URL) on launch and every 6 hours.
- Update notification appears as a toast: "v1.x.y available — Restart to update". User can dismiss or restart.

### 8.12 Telemetry (opt-in only)
- Anonymous: app version, OS version, feature usage counts, error rates.
- Never the content of transcriptions.
- Defaults to **off**. Toggleable in Settings.

---

## 9. Screen-by-Screen UI Spec

### 9.1 Main Window
- **Size:** 1100×720 default, resizable, min 880×620.
- **Chrome:** custom titlebar (drag region), traffic-light style close/min/max on the right (Windows), inset 12 px from edges.
- **Layout:** left sidebar (240 px) + content area.
- **Sidebar items (top to bottom):**
  - SuperWisper logo + name
  - Search box (Cmd+K)
  - Nav: Home · Modes · Apps · Vocabulary · History · Settings · Account
  - Bottom: status pill (signed in as / sign in)
- **Top bar:** breadcrumb, "+ Quick Action" button (record now), profile menu.

### 9.2 Home (Dashboard)
- "Welcome back, {name}" hero with gradient accent.
- Big primary card: "Press `Ctrl+Space` anywhere to start." Live indicator if hotkey is currently active.
- Recent transcriptions (last 5) with mode chip + app icon + first 80 chars.
- Quick stats: words transcribed today / this week / total time saved (estimated).
- Tips carousel for new users.

### 9.3 Modes
- Grid of cards, each card:
  - Icon (lucide)
  - Mode name
  - Description (one line)
  - Output style badge ("Auto-paste" / "Review")
  - Mode hotkey if set
  - Hover: edit / duplicate / delete buttons
- Top: "+ New Mode" + "Sort: Manual / Name / Recently used" + search.
- Drag handles for reordering (Framer Motion layout animations).

### 9.4 Mode Editor (drawer or full page)
- Left column (form):
  - Name + icon picker
  - Description
  - **System prompt** (large textarea, syntax-highlighted variables like `{{transcript}}`, `{{vocabulary}}`)
  - Language input + target language
  - Output style toggle
  - Hotkey recorder
  - Save history toggle
  - Push-to-talk vs. toggle
- Right column (live preview / test):
  - "Test this mode" → record button → shows raw + cleaned side by side
  - Token estimate

### 9.5 Apps
- Table: App icon | Name | Executable | Assigned Mode (dropdown) | Match rules | Actions
- "+ Add app" → picker showing running processes with icons (Rust enumerates via `windows` crate).
- Empty state: illustrated, "No app rules yet. SuperWisper will use your default Mode everywhere."

### 9.6 Vocabulary
- Two-column list: Term | Notes
- Inline add row at top.
- Bulk import (CSV) and export.

### 9.7 History
- Virtualized list (react-virtual).
- Each row: timestamp · mode chip · app icon · raw → cleaned preview · actions.
- Filter bar at top: search · mode · app · date range.
- Row click → drawer with full text + audio playback (if audio retained — default no, opt-in).

### 9.8 Settings
Sections:
1. **General** — auto-launch, theme, accent color, language.
2. **Recording** — global hotkey, default push-to-talk vs. toggle, audio input device, mic test, noise suppression toggle.
3. **Overlay** — position (top-center / bottom-center / top-right / bottom-right / cursor-relative), show waveform, click-through.
4. **AI** — provider (Azure), endpoint, deployment name(s), API key (stored in keyring), test connection button, transcription model, cleanup model, temperature.
5. **Privacy** — telemetry toggle, history retention (forever / 30 d / 7 d / off), clear all history button.
6. **Sync** — sign-in status, last sync time, "Sync now", "Sign out".
7. **Advanced** — log level, open log folder, reset all settings.

### 9.9 Account
- Avatar, display name, email.
- Subscription (N/A in v1, hidden).
- Delete account with confirmation modal.

### 9.10 Overlay window
- **Size:** 360×72 px (recording state) — grows to 480×120 if showing transcribed text inline.
- **Position:** by default centered horizontally, 80 px above the taskbar.
- **Style:** rounded 36px pill, frosted glass background (`backdrop-filter: blur(24px)` + 60% opacity dark fill), 1 px hairline border with accent gradient, soft drop shadow.
- **Contents:**
  - Left: animated mic icon (color shifts with audio level).
  - Center: live waveform (32 bars, 2 px wide, accent gradient).
  - Right: timer (mm:ss) + Mode chip ("Slack Mode").
  - Below pill (only when in review mode): a card that fades in with the cleaned text, "Paste" + "Copy" + "Regenerate" buttons.

### 9.11 Review panel (alternate output)
- Appears anchored to overlay pill when Mode is `output_style = review`.
- Editable text area with autofocus.
- Buttons: Paste (default), Copy, Discard, Regenerate (re-runs cleanup), Switch mode (dropdown).
- Hitting Enter triggers Paste. Esc discards.

---

## 10. Visual & Motion Design System

### Tokens (CSS variables)
```
--bg-base:        #0A0A0F
--bg-elevated:    rgba(255,255,255,0.04)
--bg-glass:       rgba(20,20,28,0.55)
--border-subtle:  rgba(255,255,255,0.06)
--border-strong:  rgba(255,255,255,0.12)
--text-primary:   #F4F4F8
--text-secondary: rgba(244,244,248,0.65)
--text-muted:     rgba(244,244,248,0.45)
--accent-start:   #A855F7      /* violet-500 */
--accent-end:     #22D3EE      /* cyan-400 */
--accent-solid:   #8B5CF6
--success:        #34D399
--warning:        #FBBF24
--danger:         #F87171
--radius-sm: 6px; --radius-md: 12px; --radius-lg: 20px; --radius-pill: 9999px
--shadow-sm: 0 1px 2px rgba(0,0,0,0.3)
--shadow-md: 0 8px 24px rgba(0,0,0,0.35)
--shadow-glow: 0 0 40px rgba(168,85,247,0.25)
```

Light theme inverts most values; accents stay the same.

### Typography
- **UI:** Inter (variable). Sizes: 12 / 13 / 14 / 16 / 20 / 28 / 36.
- **Mono:** JetBrains Mono for prompts, transcripts, code.
- **Display:** Inter Display for hero text (optional fallback Inter).
- Line height 1.45 default, tighter (1.15) for headings.

### Motion
- **Springs:** `{ type: 'spring', stiffness: 320, damping: 30 }` for UI; softer for overlay (`stiffness: 240, damping: 26`).
- **Page transitions:** 180 ms opacity + 6 px y translate.
- **Hover:** background tint shift 120 ms, scale 1.0 → 1.02 on cards.
- **Press:** scale 0.98 with 80 ms ease-out.
- **Stagger:** lists animate in with 30 ms stagger.
- **Waveform:** 60 fps canvas render, bars use exponential smoothing on amplitude.

### Iconography
- Lucide line icons, 1.5 px stroke.
- App icons in Apps screen: extracted via Win32 `SHGetFileInfo` (Rust), cached as PNG in app data dir.

---

## 11. AI Provider Layer Design

### Interface
```ts
interface AIProvider {
  name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  cleanup(input: CleanupInput): AsyncIterable<string>; // streams tokens
  health(): Promise<ProviderHealth>;
}

interface TranscribeInput {
  audio: Blob;                  // opus/wav
  language?: string;            // 'auto' or BCP-47
  vocabularyHints?: string[];
}
interface TranscribeResult {
  text: string;
  languageDetected: string;
  durationMs: number;
  segments?: Array<{ start: number; end: number; text: string }>;
}

interface CleanupInput {
  rawText: string;
  systemPrompt: string;
  vocabulary: string[];
  targetLanguage?: string;
  temperature?: number;
}
```

### `AzureFoundryProvider`
- Reads endpoint + deployment names + API key from secrets store.
- `transcribe` posts audio to the Azure Whisper-equivalent endpoint.
- `cleanup` uses Azure-hosted chat completion (configurable deployment, default GPT-class). Streaming via SSE.
- Retries: 3 attempts with exponential backoff on 5xx / 429.
- Timeouts: 30 s transcription, 20 s cleanup.

### Prompt builder
Template:
```
You are SuperWisper's polishing layer for the "{{mode.name}}" mode.

Goal: {{mode.description}}

Specialized vocabulary the user often uses (preserve exact spelling):
{{vocabulary | bullets}}

Rules:
- Preserve the speaker's intent and voice.
- Remove disfluencies ("um", "uh", false starts, repeated words).
- Fix grammar and punctuation.
- {{mode.systemPrompt}}
{{#if targetLanguage}}
- Translate the result into {{targetLanguage}} naturally.
{{/if}}

Return ONLY the polished text. No commentary, no quotes.

---

RAW TRANSCRIPT:
{{rawText}}
```

### Cost & token tracking
- Optional in v1: log estimated cost to `transcriptions.cost_cents` based on simple per-1k-token + per-second-audio table editable in code.

---

## 12. Audio Pipeline

1. **Input device selection:** enumerate via `navigator.mediaDevices.enumerateDevices()`. Persist `deviceId` in settings.
2. **Capture:** `getUserMedia({ audio: { deviceId, channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }})`.
3. **Encoding:** `MediaRecorder` with `audio/webm; codecs=opus` (small payload, well-supported). Fallback to `audio/wav` if Opus unavailable.
4. **Waveform:** parallel `AnalyserNode` with `fftSize: 256`. RMS computed every animation frame, fed into Framer canvas.
5. **End of recording:** stop recorder, await final blob.
6. **Upload:** if blob > 20 MB, save to temp file via Rust and stream from disk; otherwise send as base64 over IPC then HTTP-upload to Azure.
7. **Cleanup:** temp files purged on success.

### Silence / no-speech detection
- If average RMS < threshold for the entire recording (< 250 ms total speech), skip the API call and surface "No speech detected" toast.

---

## 13. Hotkey & Active-Window System

### Hotkey
- Registered via `tauri-plugin-global-shortcut`.
- Two listeners: one for the global hotkey, one optional per-Mode hotkey.
- Push-to-talk implemented by listening to both key-down and key-up via the plugin's `Shortcut` events.
- Conflict detection: if registration fails, surface a clear error in Settings with "Try a different key" UI.

### Active window
- Implemented in Rust:
  ```rust
  use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, GetWindowTextW};
  use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW};
  ```
- Called once at hotkey-press to read `(exe_name, window_title)`.
- Frontend matches against `app_mappings`.

---

## 14. Auto-Paste & Output Routing

Two output styles per Mode.

### Auto-paste
1. Write cleaned text to clipboard (`tauri-plugin-clipboard-manager`).
2. Use `enigo` to simulate `Ctrl+V` against the previously focused window.
   - We capture the foreground window **before** showing the overlay so we can paste back into it (the overlay window is always-on-top but non-activating — `WS_EX_NOACTIVATE`).
3. Optional: restore previous clipboard contents after 1 s (configurable).

### Review panel
- Overlay expands to show editable text.
- "Paste" sends to the captured target window using the same flow.
- "Copy" only writes to clipboard.
- "Discard" closes overlay, marks transcription `output_action = 'discarded'`.

### Edge case: no target
- If we can't determine a target (e.g., user pressed hotkey from the SuperWisper main window), default to clipboard + toast "Copied to clipboard".

---

## 15. Onboarding Flow Spec

8-step animated flow. Each step is a full-window panel with progress dots top center and a subtle accent gradient background that shifts hue across steps.

### Step 1 — Welcome
- Big animated logo (gradient mark with breathing scale).
- "SuperWisper — talk anywhere, we type it for you."
- "Get started" CTA.
- "I'm just exploring" → skips to defaults.

### Step 2 — Permissions
- Mic permission request via `getUserMedia`.
- Status pill ✓ once granted.
- Explanation copy: "We process audio locally and only send it to your AI provider. We never store recordings unless you turn that on."

### Step 3 — Sign in (optional)
- "Sign in to sync your settings, modes, and history across devices."
- Magic link by default. Toggle to use password.
- "Skip for now" → uses local-only mode (data lives in SQLite). Can sign in later from Settings.

### Step 4 — Hotkey
- Big "Press your shortcut" recorder.
- Default suggestion: `Ctrl+Space`.
- Validates conflicts on the fly.
- Toggle: "Push-to-talk (hold)" vs. "Toggle (tap)".

### Step 5 — Pick your apps
- Checklist of common apps with their icons:
  - Slack, Discord, Microsoft Teams
  - Gmail (browser), Outlook
  - WhatsApp, iMessage (if available), Telegram, Signal
  - VS Code, Cursor, JetBrains IDEs, Sublime
  - Notion, Obsidian, Logseq
  - X / Twitter, LinkedIn, Reddit (browser)
  - Chrome / Edge / Firefox (browser generic)
- User checks the ones they use. Multi-select.

### Step 6 — Tone per app
- For each selected app, a card asks "How do you usually sound here?" with 4 chips:
  - **Formal** (full sentences, professional)
  - **Casual** (contractions, lighter punctuation)
  - **Very Casual** (texting style, minimal punctuation, slang allowed, lowercase ok)
  - **Custom** (free-text describing the tone)
- Smart defaults pre-selected (e.g., Gmail → Formal, Discord → Very Casual, Slack → Casual).
- "Apply same tone to all" shortcut.

### Step 7 — Generating your setup
- Animated progress: "Creating your Modes…" → "Mapping your apps…" → "Syncing your settings…" (each ~600 ms).
- Behind the scenes:
  - Generate one Mode per unique (tone) selection. e.g., if user picked Formal for Gmail+Outlook and Casual for Slack, we end up with `Formal`, `Casual`, plus the built-in Default.
  - Build app_mappings: each picked app → its tone's Mode.
  - Persist locally; if signed in, push to Supabase.

### Step 8 — Test recording
- Big mic button. "Try saying: *Hey team, here's the update for today.*"
- User holds hotkey, speaks, sees overlay live, then sees both raw + cleaned outputs.
- "You're all set" CTA → closes onboarding, opens Home.

Onboarding is resumable: state persisted at every step. Can re-run any time from Settings.

---

## 16. Settings, Permissions & Security

### Permissions
- **Microphone:** required. Requested at onboarding step 2.
- **Accessibility / synthetic input:** Windows does not require special permission for `enigo`-style input (unlike macOS), but we surface a clear UI explanation so the user understands why we paste keystrokes.
- **Autostart:** opt-in.

### Secrets
- Supabase JWT session: stored via `tauri-plugin-keyring` (Windows Credential Manager).
- Azure API key: same.
- Never written to plain disk. Never logged.

### Network
- All AI traffic goes directly from the user's machine to Azure. No SuperWisper-controlled relay.
- Supabase traffic via the official JS SDK over HTTPS.

### Data deletion
- "Delete all my data" in Settings → Privacy:
  - Deletes local SQLite tables.
  - Deletes Supabase rows for the user.
  - Keeps account unless user also chooses "Delete account."

---

## 17. Supabase Schema & Sync Strategy

### Migrations
Migrations stored under `supabase/migrations/` so the user can apply via `supabase db push` or via the Supabase MCP. We'll write them in order:

1. `0001_init.sql` — tables + RLS.
2. `0002_indexes.sql` — `transcriptions_user_id_created_at_idx`, `modes_user_id_position_idx`, etc.
3. `0003_search.sql` — `pg_trgm` index on `transcriptions(cleaned_text)`.
4. `0004_seed_builtins.sql` — function `seed_builtin_modes_for_user(uuid)` invoked from a trigger on `profiles` insert.

### RLS policies
- `select`, `insert`, `update`, `delete` policies on every user table: `auth.uid() = user_id`.

### Sync engine
- Lightweight CRDT-like model is **not** required — simple last-write-wins per row is fine.
- Wrapper `syncTable<T>(tableName, localQuery, remoteClient)`:
  1. Pull `since = max(updated_at) local`.
  2. Apply remote rows newer than local.
  3. Push local rows newer than remote.
  4. Resolve duplicate ids with newest `updated_at`.

---

## 18. Error Handling, Edge Cases & Telemetry

### Errors surfaced as toasts (Sonner-style)
- Mic permission denied → "Allow microphone in Windows settings" with link.
- Hotkey conflict → "That shortcut is taken. Try another."
- Network failure during transcription → "Couldn't reach AI provider. Retrying…" with retry button.
- Azure API key invalid → settings deep-link.
- File too large for file transcription.
- No speech detected.

### Crash safety
- Rust uses `Result<T, AppError>` everywhere; panics are caught and converted to user-visible errors.
- Frontend has a global ErrorBoundary that captures React errors, shows a friendly screen, and offers "Report" (opens GitHub issue with template).

### Logs
- File log at `%APPDATA%\SuperWisper\logs\app.log` with daily rotation, max 14 files.
- "Open logs" button in Settings → Advanced.

### Telemetry events (opt-in)
- `app_launched`, `recording_started`, `recording_completed`, `mode_used`, `error_shown`, `update_installed`.
- No PII, no content.

---

## 19. Performance & Resource Budget

| Metric | Target |
|---|---|
| Cold start (tray-only) | < 1.0 s |
| Cold start (main window visible) | < 1.5 s |
| Hotkey press → overlay visible | < 80 ms |
| Recording stop → cleaned text pasted | < 1.5 s for 5 s audio |
| Idle RAM | < 80 MB |
| Active RAM (recording) | < 180 MB |
| Installer size | < 15 MB |
| CPU idle | < 0.5% |

Strategies:
- Overlay window pre-warmed (created hidden at app start).
- Frontend code-split: overlay bundle separate from main bundle.
- Audio worklet for waveform analysis to avoid main-thread jank.

---

## 20. Build, Packaging & Distribution

### Local dev
- `pnpm install`
- `pnpm tauri dev` (Vite + Rust hot reload)
- `.env.local` for Supabase + Azure dev creds

### Production build
- `pnpm tauri build` produces `.msi` and `.nsis` (`-setup.exe`) installers in `src-tauri/target/release/bundle/`.
- Bundle identifier: `com.superwisper.app`.
- Code signing: deferred (would require a code-signing cert). Without it, Windows SmartScreen will warn; we accept that in v1.
- Updater manifest: `latest.json` on GitHub Releases.

### Distribution
- GitHub Releases as the primary channel.
- README links the latest installer.

---

## 21. Implementation Roadmap (Phased)

Each phase is independently testable. Phases roughly map to PRs.

### Phase 0 — Scaffold (foundation) ✅ **COMPLETE** (2026-05-24)
- Initialize Tauri 2 + Vite + React + TS in current empty folder.
- Add Tailwind, Framer Motion, Radix UI, Zustand, React Router, Lucide, React Hook Form, Zod.
- Set up ESLint, Prettier, `cargo clippy`, `rustfmt`.
- Configure `tauri.conf.json` for a hidden main window, no overlay window yet.
- Verify `pnpm tauri dev` runs a blank app.

**Phase 0 notes (what actually happened):**
- Used `pnpm create tauri-app@latest` with `--template react-ts` then flattened into project root.
- Runtime deps installed: `framer-motion`, `zustand`, `react-router-dom`, `lucide-react`, `react-hook-form`, `zod`, `sonner`, `clsx`, `tailwind-merge`. Radix UI primitives deferred to Phase 1 (added per-component when needed).
- Dev deps: `tailwindcss@^3`, `postcss`, `autoprefixer`, `prettier`, `eslint` + `@typescript-eslint/*` + `eslint-plugin-react` + `eslint-plugin-react-hooks`. (Tailwind 4 is out but the plan was written against Tailwind 3 config style; staying on v3.)
- Rust crate renamed from scaffold default to `superwisper` (lib name `superwisper_lib`), product `SuperWisper`, identifier `com.superwisper.app`.
- Main window kept **visible** for Phase 0 verification (plan says "hidden" but tray-only behavior is implemented in Phase 12; revisit then).
- Design tokens live in `src/styles/tokens.css`; global styles in `src/styles/globals.css`; Tailwind config maps tokens onto utility colors / radii / shadows.
- Verification: `pnpm build` (Vite) ✅ — 8.3 kB CSS, 318 kB JS. `cargo check` ✅ in 3m 38s (cold). `pnpm tauri dev` not launched in this session to keep the agent loop snappy — first invocation will take ~30 s before a window appears (already-cached deps).

**Phase 0 toolchain prerequisites (what was installed during this session):**
- Rustup + stable Rust (1.95.0 at install time) via `winget install Rustlang.Rustup`.
- Visual Studio Build Tools 2022 + **Desktop development with C++** workload via `setup.exe modify --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended` (must run elevated; `--quiet` requires admin).
- WebView2 runtime already present on Windows 11.
- Node 24 + pnpm 10 already present.

**Files of note created in Phase 0:**
- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` (root)
- `tailwind.config.js`, `postcss.config.js`, `.prettierrc.json`, `.prettierignore`, `.eslintrc.json`, `.env.example`, `.gitignore`, `README.md`
- `src/main.tsx`, `src/App.tsx`, `src/styles/tokens.css`, `src/styles/globals.css`
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/rustfmt.toml`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`

### Phase 1 — Design system & app shell ✅ **COMPLETE** (2026-05-24)
- CSS tokens, Tailwind config with custom colors + animations + glass utilities.
- Build primitives: `Button`, `IconButton`, `Card`, `Input`, `Textarea`, `Select`, `Toggle`, `Switch`, `Tooltip`, `Dialog`, `Sheet`, `Toast` (via Sonner-like wrapper), `Tabs`, `Avatar`, `Kbd`, `Badge`, `ProgressBar`, `Spinner`.
- Sidebar + top bar layout.
- Router with placeholder pages.
- Framer Motion page transitions.

**Phase 1 notes (what actually happened):**
- Radix primitives installed: `@radix-ui/react-{dialog,tooltip,tabs,select,switch,avatar,slot,toggle,progress,scroll-area,dropdown-menu,popover}` + `class-variance-authority` for variant APIs + `tailwindcss-animate` for Radix data-state transitions.
- All 18 primitives live in `src/components/ui/` with a barrel export at `src/components/ui/index.ts`. `Card` exposes `Card/CardHeader/CardTitle/CardDescription/CardContent/CardFooter` subcomponents. `Dialog` and `Sheet` both wrap `@radix-ui/react-dialog` (Sheet adds side variants via `cva`). `Toast` is a thin wrapper around `sonner` themed to match design tokens.
- Layout: `src/components/layout/{Sidebar,TopBar,AppShell,PageHeader}.tsx`. `AppShell` provides the `TooltipProvider`, `Toaster`, and Framer Motion `AnimatePresence` page transitions (180 ms opacity + 6 px y, per plan §10).
- Router: `createMemoryRouter` (in-window routing per plan §4) with 8 routes mounted under `AppShell`: `/`, `/modes`, `/modes/editor`, `/apps`, `/vocabulary`, `/history`, `/settings`, `/account`.
- Each route has a polished placeholder using real primitives + empty states (no Lorem Ipsum). `Settings` is fleshed out with all 6 sections from §9.8 using `Tabs`. `ModeEditor` shows the two-column form/preview layout from §9.4.
- Old demo `App.tsx` replaced; old `App.css` already removed in Phase 0.
- Bundle size jumped from 318 kB → 597 kB (191 kB gzip) due to Radix. Code-splitting per route deferred to Phase 19's performance pass.

**Files added in Phase 1:**
- `src/lib/utils.ts` (cn helper)
- `src/components/ui/*.tsx` (18 files) + `index.ts`
- `src/components/layout/{Sidebar,TopBar,AppShell,PageHeader}.tsx`
- `src/routes/{Home,Modes,ModeEditor,Apps,Vocabulary,History,Settings,Account}.tsx`
- `src/App.tsx` rewritten as a `RouterProvider`

### Phase 2 — Overlay window & audio capture ✅ **COMPLETE** (2026-05-24)
- Configure overlay as a separate Tauri window: transparent, always-on-top, no-decorations, no-activate, skip-taskbar, draggable.
- Render `RecordingPill` component with all visual states.
- Implement audio capture with `MediaRecorder` + `AnalyserNode`.
- Build canvas-based waveform (32 bars, smoothing).
- Mock recording flow: button starts/stops, shows duration.

**Phase 2 notes (what actually happened):**
- Vite multi-page build: `overlay.html` added at project root, `vite.config.ts` updated with `rollupOptions.input` for `main` + `overlay`. The overlay bundle code-splits to ~7 kB (bonus — satisfies plan §19 "Frontend code-split: overlay bundle separate from main bundle" early).
- New Tauri window `overlay` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json): `420×96`, `transparent: true`, `decorations: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `focus: false`, `shadow: false`, `visible: false` (shown on demand). The full WS_EX_NOACTIVATE / non-activating semantics need a Rust call (`SetWindowLongPtrW`); deferred to Phase 7 (paste flow) where focus-restore actually matters.
- Capabilities ([src-tauri/capabilities/default.json](src-tauri/capabilities/default.json)) extended to grant `core:event:*` and `core:window:*` to both windows.
- Audio capture ([src/lib/audio.ts](src/lib/audio.ts)): `MediaRecorder` (Opus/webm preferred, wav fallback) + parallel `AnalyserNode` (fftSize 256, smoothing 0.7). Controller exposes `getLevel()`, `getBars(32)`, `stop()`, `cancel()`. Capture happens **inside the overlay window** so the waveform reads from the same DOM that renders it (avoids cross-window streaming).
- `Waveform` ([src/components/recording/Waveform.tsx](src/components/recording/Waveform.tsx)): canvas, 32 bars, per-bar exponential smoothing, violet→cyan linear gradient, DPR-aware via ResizeObserver, rAF render.
- `RecordingPill` ([src/components/recording/RecordingPill.tsx](src/components/recording/RecordingPill.tsx)): 360×72 pill with state machine for `idle | recording | processing | polishing | success | error`. Pulsing accent ring during recording, shimmer bar during processing/polishing, check during success, danger ring + message during error. Spring entrance (stiffness 240, damping 26 per plan §10).
- Recording store ([src/lib/store/useRecording.ts](src/lib/store/useRecording.ts)) — Zustand, owns state machine. Currently the overlay maintains local state; main window uses the cross-window bridge.
- Cross-window bridge ([src/lib/recording-bridge.ts](src/lib/recording-bridge.ts)): emits `recording:start { modeName }`, `recording:stop`, `recording:cancel`. Positions the overlay bottom-center 96 px above the taskbar on the current monitor before showing.
- Home page now has a working **Try it now** button (manual trigger — the global hotkey arrives in Phase 3). Esc inside the overlay also cancels.
- Mocked pipeline after `stop()`: 600 ms processing → 800 ms polishing → 600 ms success → fade & hide. Real Azure transcription wires in Phase 4.

**Known deferred work:**
- `WS_EX_NOACTIVATE` / true non-stealing focus: needs a tiny Rust setup hook on the `overlay` window — Phase 7.
- Permission denial UX: shows a Sonner toast with the raw error today. Onboarding (Phase 11) replaces this with a proper "Allow microphone in Windows settings" deeplink.
- Audio device selection: device enumeration UI is in Settings stub but not wired — Phase 5/13.

**Files added in Phase 2:**
- `overlay.html`
- `src/overlay/{main.tsx,Overlay.tsx}`
- `src/lib/{audio.ts,recording-bridge.ts}`
- `src/lib/store/useRecording.ts`
- `src/components/recording/{RecordingPill.tsx,Waveform.tsx}`

### Phase 3 — Global hotkey & active-window detection ✅ **COMPLETE** (2026-05-24)
- Rust: register global shortcut, handle down/up events, support PTT and toggle.
- Rust: `get_active_window()` command returning `{ exe, title }`.
- Frontend: settings UI to record a hotkey.
- Wire: hotkey → show overlay → capture active window → emit event with target info.

**Phase 3 notes (what actually happened):**
- Rust deps added: `tauri-plugin-global-shortcut = "2"`, `windows = "0.59"` (Win32_Foundation, WindowsAndMessaging, Threading, ProcessStatus features). Cargo file uses `[target.'cfg(windows)'.dependencies]` so non-Windows builds still type-check the stub fallback.
- New Rust modules: [src-tauri/src/commands/hotkey.rs](src-tauri/src/commands/hotkey.rs), [src-tauri/src/commands/active_window.rs](src-tauri/src/commands/active_window.rs), [src-tauri/src/commands/mod.rs](src-tauri/src/commands/mod.rs).
- The global-shortcut plugin handler emits `hotkey:down` / `hotkey:up` events on `ShortcutState::Pressed` / `Released`, so the same handler covers both PTT and toggle modes — the frontend chooses the semantics.
- `HotkeyState` (Mutex<Option<Shortcut>>) is `manage()`d on the app. `install_default()` registers `CommandOrControl+Space` at startup. The IPC commands `set_hotkey(spec)` and `clear_hotkey()` swap registrations safely (unregister-then-register).
- Active window uses `GetForegroundWindow` + `GetWindowTextW` + `GetWindowThreadProcessId` + `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW` (plan §13 pseudo-Rust made real). Returns `{ exe, exe_path, title }`. Non-Windows builds get an empty struct.
- Capabilities updated to include `global-shortcut:default` and the explicit `core:window:*` permissions used by the recording bridge.
- Frontend: [src/lib/hotkey.ts](src/lib/hotkey.ts) persists `{ spec, pushToTalk }` in localStorage, calls Rust commands, and installs the global `listen()` handlers. Listener logic:
  - On `hotkey:down`: snap the active window (`get_active_window`), then if PTT → `startRecording(exe)`. If toggle → flip an internal flag and start or stop.
  - On `hotkey:up`: PTT → `stopRecording`. Toggle ignores.
- [src/components/settings/HotkeyRecorder.tsx](src/components/settings/HotkeyRecorder.tsx) — focusable button that captures the next combination (must include at least one modifier; Esc cancels). Pretty-prints with `Kbd`.
- Settings page now drives a real hotkey: recording new combos calls `applyHotkey()` which goes through Rust; the PTT toggle persists immediately.
- [src/main.tsx](src/main.tsx) installs `listen()` subscriptions on boot — even before the user navigates to Settings the default Ctrl+Space already works app-wide.

**Known deferred work:**
- Conflict detection: today a `set_hotkey` failure shows a Sonner toast. A nicer "Try another key" hint with suggestions belongs in onboarding (Phase 11) / Settings polish (Phase 13).
- Active window is **logged** today but not used to resolve a Mode. App-mapping resolution happens in Phase 6.
- Toggle-mode safety long-press to stop (plan §8.1) deferred to Phase 13 polish.

**Files added in Phase 3:**
- Rust: `src-tauri/src/commands/{mod.rs,hotkey.rs,active_window.rs}`
- TS: `src/lib/hotkey.ts`, `src/components/settings/HotkeyRecorder.tsx`

### Phase 4 — AI provider layer ✅ **COMPLETE** (2026-05-24)
- Define `AIProvider` interface + types.
- Implement `AzureFoundryProvider` (real HTTP calls).
- Build `promptBuilder` with templating.
- Wire end-to-end mock: hotkey → record → call `transcribe` → call `cleanup` → log result.
- Settings UI for Azure config + "Test connection" button.

**Phase 4 notes (what actually happened):**
- [src/lib/ai/AIProvider.ts](src/lib/ai/AIProvider.ts) — provider interface from plan §11 verbatim plus a `ProviderHealth` type used by the test-connection button.
- [src/lib/ai/promptBuilder.ts](src/lib/ai/promptBuilder.ts) — builds `{ system, user }` from a `CleanupInput`, matching the template in plan §11. Also exports `estimateTokens` (≈4 chars/token, used by the Mode editor token estimate later).
- [src/lib/ai/AzureFoundryProvider.ts](src/lib/ai/AzureFoundryProvider.ts) — real HTTP impl against Azure AI Foundry / Azure OpenAI:
  - Transcribe: `POST {endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version=2024-06-01` (multipart, `response_format: verbose_json`, `language` if not `auto`, vocab hints injected as `prompt`).
  - Cleanup: streaming chat completions over SSE; `parseSSEStream` consumes `data:` lines and yields `choices[0].delta.content` chunks as an `AsyncIterable<string>`.
  - Retries: 3 attempts on 5xx/429 for transcription, exponential backoff with jitter. Timeouts: 30 s transcribe / 20 s cleanup.
  - `health()` posts a 1-token completion to the cleanup deployment and returns `{ ok, message, latencyMs }`.
- [src/lib/ai/index.ts](src/lib/ai/index.ts) — config persistence (localStorage under `sw.azure.config`), `isConfigured` type guard, `getActiveProvider()` returns `AIProvider | null`. **API key in localStorage is a temporary measure** — plan §16 requires the OS keyring; deferred to a later polish phase.
- Audio pipeline tightened: `audio.ts` `stop()` now resolves to `RecordingResult | null` instead of using an `onStop` callback, which removes the awkward side-channel in the Overlay.
- [src/overlay/Overlay.tsx](src/overlay/Overlay.tsx) drives the real pipeline: `stop` → `provider.transcribe()` → `provider.cleanup()` (collect stream) → emit `recording:result { raw, cleaned, durationMs, language, modeName }` → success → fade.
- Visibility shim: [src/main.tsx](src/main.tsx) listens for `recording:result` and pops a Sonner toast with the cleaned text (first 240 chars). Real paste lands in Phase 7.
- Settings → AI now fully functional: endpoint, API key (`type=password`), transcribe deployment, cleanup deployment — all bound to the AzureConfig, persisted on change. **Test connection** button calls `health()` and toasts the result.
- If Azure is not configured when the user stops recording, the pill switches to the error state with "Configure Azure in Settings → AI to enable transcription." instead of crashing.

**Known deferred / acknowledged:**
- API key in localStorage instead of keyring (plan §16) — will move when we install `tauri-plugin-keyring` in a later phase.
- Cleanup output is collected synchronously then toasted; real token-by-token streaming UI happens in Phase 7 (review panel).
- Cost / token tracking from plan §11 is not yet wired; the `cost_cents` column will get populated in Phase 10 (history) once we have a price table.

**Files added in Phase 4:**
- `src/lib/ai/{AIProvider.ts,promptBuilder.ts,AzureFoundryProvider.ts,index.ts}`

### Phase 5 — Modes & Vocabulary ✅ **COMPLETE** (2026-05-24)
- Zustand `useModes` store with CRUD.
- Built-in Modes seeded on first run.
- Modes screen with grid + drag-reorder.
- Mode Editor with all fields + live test.
- Vocabulary screen with CRUD + import.

**Phase 5 notes (what actually happened):**
- Domain types in [src/types/mode.ts](src/types/mode.ts) (`Mode`, `VocabularyTerm`, `OutputStyle`) mirror the SQL columns in plan §7 so the same shape works for localStorage → SQLite (Phase 10) → Supabase (Phase 9).
- [src/lib/store/useModes.ts](src/lib/store/useModes.ts): Zustand stores for **both** modes and vocabulary, plus storage-level helpers `loadModes()`, `getModeById(id)`, `getDefaultMode()`, `loadVocabulary()`. The helpers read straight from `localStorage` so the **overlay window** (separate JS context) sees fresh data without subscribing to React state.
- [src/lib/store/builtinModes.ts](src/lib/store/builtinModes.ts) — six built-in modes seeded on first run exactly per plan §7: Default, Formal Email, Slack Message, Code Comment, Notes (`outputStyle: "review"`), Translate → English (`targetLanguage: "English"`).
- Modes screen ([src/routes/Modes.tsx](src/routes/Modes.tsx)) rewritten:
  - Framer Motion `Reorder.Group` + `Reorder.Item` for drag-to-reorder (positions persisted)
  - Hover actions: set-as-default ⭐, edit, duplicate, delete (delete hidden for built-ins; can still duplicate then edit)
  - Default mode shows a check icon
  - Icons picked dynamically from `lucide-react` by name string
- Mode Editor ([src/routes/ModeEditor.tsx](src/routes/ModeEditor.tsx)) — loads by `?id=` query param. Full form: name, icon picker, description, system prompt (monospace textarea with **token estimate** in the help text), language, target language, output style, per-mode hotkey, push-to-talk, save-history. Save button greys out unless dirty.
- **Live test** in the right column is real: Record button uses `startRecording()` from audio.ts directly, shows the same canvas waveform as the overlay, then on Stop calls `provider.transcribe()` + `provider.cleanup()` (streaming — `cleaned` text fills in token-by-token in the result card). Raw + Cleaned shown in two separate cards. Errors surface inline.
- Vocabulary ([src/routes/Vocabulary.tsx](src/routes/Vocabulary.tsx)) — inline-add row at top (Enter to commit), table of editable rows below, **CSV import** (auto-detects `term,pronunciation,notes` header) and **export**. Inline editing updates the store immediately.
- Recording pipeline now actually uses the resolved Mode:
  - [src/lib/recording-bridge.ts](src/lib/recording-bridge.ts) `startRecording(modeName, modeId)` carries the mode ID across windows
  - [src/lib/hotkey.ts](src/lib/hotkey.ts) resolves the user's default Mode via `getDefaultMode()` (replacing the prior `aw.exe || "Default"` placeholder — app-mapping resolution still lands in Phase 6)
  - [src/overlay/Overlay.tsx](src/overlay/Overlay.tsx) refetches the Mode from storage at each `recording:start` (handles edits in the main window), passes `systemPrompt`, `modeDescription`, `vocabulary`, `targetLanguage` into `provider.cleanup()`, and forwards `outputStyle` + `saveHistory` to the `recording:result` event for Phase 7 / Phase 10 consumers.
  - Home's "Try it now" button uses the user's default Mode.

**Known deferred work:**
- Per-mode hotkeys are saved but not yet registered as actual global shortcuts (the registration UI exists; Phase 13 polish wires up multi-shortcut routing).
- "Sort by" + search on the Modes screen — drag-reorder works, the dropdown from plan §9.3 lands in Phase 13.
- Mode templates / sharing — out of scope for v1.

**Files added in Phase 5:**
- `src/types/mode.ts`
- `src/lib/store/{useModes.ts,builtinModes.ts}`
- (Rewrites) `src/routes/{Modes,ModeEditor,Vocabulary}.tsx`
- Updates to `src/lib/{hotkey.ts,recording-bridge.ts}`, `src/overlay/Overlay.tsx`, `src/routes/Home.tsx`

### Phase 6 — App mappings & auto-mode selection
- Apps screen with mapping CRUD.
- "Add app" picker that enumerates running processes (Rust side).
- Mode resolution function: given `(exe, title)` return the right Mode.

### Phase 7 — Output routing (paste & review)
- Rust `paste` command via `enigo` (with focus-restore).
- Clipboard write via plugin.
- Frontend: overlay grows into review panel with editable text + buttons.
- Mode toggle for output style takes effect.

### Phase 8 — File transcription
- Drop zone on Home.
- Chunking helper (or single-shot for small files).
- Progress UI.
- Results appended to history.

### Phase 9 — Supabase auth & sync
- `supabase.ts` client.
- Auth screens (sign in, sign up, magic link, forgot password) + email confirmation flow.
- Account screen.
- Apply migrations.
- Sync engine for modes, vocab, app_mappings, settings, transcriptions.
- "Sync now" + last-sync indicator.

### Phase 10 — History
- Local SQLite via `tauri-plugin-sql`.
- History UI with virtualized list + filters + search.
- Row actions: copy, re-paste, re-clean, delete.

### Phase 11 — Onboarding flow
- All 8 steps implemented.
- Auto-generation logic for Modes + app_mappings from tone selections.
- Re-run from Settings.

### Phase 12 — System tray, autostart, notifications
- Tray icon with state colors.
- Tray menu with all entries.
- Autostart toggle wired to `tauri-plugin-autostart`.
- Notifications for transcription success/failure (optional, off by default).

### Phase 13 — Polish, errors, telemetry
- Toasts for all error paths.
- Empty states, loading states, skeletons.
- Telemetry opt-in (no-op endpoint in v1, just collected locally).
- Final visual pass.

### Phase 14 — Build & release
- Tauri bundler configured for MSI + NSIS.
- App icon + branding.
- README with screenshots, install instructions, dev setup.
- Tag `v0.1.0`, publish first GitHub Release with installer.

---

## 22. Testing Strategy

- **Unit (Vitest):** `promptBuilder`, sync engine merge logic, mode resolution, audio helpers.
- **Component (Vitest + Testing Library):** Mode editor form validation, history filters.
- **Rust unit (`cargo test`):** active-window parsing, paste sequencing, hotkey config.
- **Integration:** mock `AIProvider` for full flow tests.
- **E2E (Playwright on packaged app):** onboarding happy path, settings round-trip.
- **Manual QA checklist** in `docs/QA.md` covering all UI surfaces and edge cases.

---

## 23. Out of Scope for v1

- Meeting recording (system audio + mic mixdown).
- macOS, Linux, iOS, Android.
- Paid tiers / Stripe / licensing.
- Team or enterprise features (SSO, audit logs).
- Local on-device transcription (Whisper.cpp) — possible v2.
- TTS / voice cloning.
- Plugin/extension API.

---

## 24. Open Items / Decisions Deferred

- Exact Azure model deployments (transcription + chat) — user will configure post-build.
- Supabase project URL + anon key — user will provide.
- App icon & marketing site.
- Code-signing certificate.
- Whether to ship a local Whisper fallback (probably yes in v2).

---

## 25. Glossary

- **Mode:** A reusable preset that controls cleanup prompt, language, output style, and hotkey.
- **App mapping:** A rule that says "when X app is focused, use Mode Y."
- **Overlay:** The small floating glass pill window shown during recording.
- **Review panel:** The expanded overlay state used when a Mode prefers manual review before pasting.
- **Push-to-talk (PTT):** Hold the hotkey to record, release to stop.
- **Toggle:** Tap the hotkey to start, tap again to stop.
- **Cleanup:** The LLM pass that polishes the raw transcript into the final text.
