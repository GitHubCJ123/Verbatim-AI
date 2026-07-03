# 02 — Menu Simplification + Settings Search

## Current inventory

**Sidebar** (`src/components/layout/Sidebar.tsx`): Home · Modes · Apps ·
Vocabulary · History · Settings · Account.

**Settings tabs** (`src/routes/Settings.tsx`, 1,415 lines): General · AI
model · Recording · Overlay · Privacy · Advanced.

### Findability problems found

1. **AI settings are split**: provider pickers live in "AI model", but
   "Test AI connection" is under Advanced. Ollama troubleshooting copy says
   "Settings → AI" — a tab that doesn't exist (it's "AI model").
2. **Privacy is split**: history on/off lives in the Privacy tab, but History
   is also a top-level page; cloud-vs-local (the biggest privacy decision) is
   in "AI model", not Privacy.
3. **Recording vs. Overlay** is a distinction users don't have: hotkey and
   mic are "Recording" while pill position and clipboard-restore are
   "Overlay" — both are "how dictation behaves".
4. **Account vs. Settings** are separate sidebar items with overlapping
   mental scope (sync, sign-out, data deletion).
5. plan.md §9.1 specified a sidebar **search box (Cmd+K)** that was never
   built.

## Design

### A. Settings registry (enables search *and* keeps IA honest)

Create `src/lib/settingsRegistry.ts`:

```ts
export interface SettingEntry {
  id: string;              // "hotkey", "mic-device", "theme"…
  title: string;           // "Global hotkey"
  description: string;
  keywords: string[];      // ["shortcut", "keybinding", "push to talk"…]
  tab: SettingsTab;        // which tab renders it
  route?: string;          // for entries living outside /settings (Modes, Vocabulary…)
}
export const SETTINGS: SettingEntry[] = [ /* every SettingRow + key pages */ ];
```

Each `SettingRow` in `Settings.tsx` gets `id={entry.id}` so search results can
deep-link: `/settings?tab=recording&highlight=hotkey` → switch tab, scroll
into view, flash the row (2 s accent ring). `Tabs` must become controlled
(read `useSearchParams`).

### B. Command palette (Cmd+K)

`src/components/CommandPalette.tsx`, mounted in `AppShell`:
fuzzy-match over `SETTINGS` (title + keywords) **plus** nav pages
("Modes", "History"…) and a few actions ("Re-run onboarding",
"Check for updates"). Plain `Dialog` + input + filtered list is enough — no
new dependency needed (or use `cmdk` if preferred). Sidebar gets a small
"Search ⌘K" affordance above the nav.

### C. Tab reorganization (do after A/B; cheap once registry exists)

Proposed 4 tabs, task-oriented:

| Tab | Contents |
|---|---|
| **General** | startup, theme, updates, version |
| **Dictation** | hotkey, push-to-talk, microphone, overlay position, clipboard restore |
| **AI & Privacy** | transcription provider, cleanup provider, model management, **data-locality indicator** (doc 05), history on/off, telemetry, test connection |
| **Advanced** | log level, re-run onboarding, devtools |

Merge **Account into Settings** as a header card or 5th tab; drop the
sidebar item (sidebar becomes: Home · Modes · Apps · Vocabulary · History ·
Settings).

## Implementation steps

1. Build the registry with entries for all existing rows (pure data, no UI
   change). Add `id` props to `SettingRow`s.
2. Controlled tabs + `?tab=&highlight=` deep-linking + row flash.
3. Command palette + sidebar search affordance + global Cmd+K listener.
4. Tab regroup per table above (move JSX between `TabsContent` blocks;
   update registry `tab` fields; update any copy referencing old tab names —
   grep for `Settings →`).
5. Fold Account page into Settings; remove sidebar item; add redirect from
   `/account`.

## Acceptance criteria

- Cmd+K → type "shortcut" → Enter lands on the hotkey row, highlighted.
- Every setting reachable via search with ≥ 3 sensible keywords.
- No copy references a nonexistent tab name.
- Steps 1–3 ship without moving any setting (zero relearning risk); step 4
  is the only IA change and lands separately.
