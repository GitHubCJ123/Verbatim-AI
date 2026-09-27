# Adversarial review

I'll review this spec by grounding it against the actual repository. Let me read the spec file and the key referenced code.

● Read spec.md
  │ docs/automation/specs/issue-0073-warn-on-global-hotkey-conflicts-where-detectable/spec.md
  └ 419 lines read

● Read Settings.tsx
  │ src/routes/Settings.tsx
  └ L680:720 (41 lines read)

● Read hotkey.rs
  │ src-tauri/src/commands/hotkey.rs
  └ 141 lines read

Let me verify the spec's repo claims against reality — the frontend error path, shortcut format, test harness, and any existing normalization helper.

/ Search (grep)
  │ "set_hotkey|setHotkey|Couldn't register|register that shortcut|invoke\(" (src)
  └ 35 lines found

/ Search (grep)
  │ "normalizeShortcut|normalize|toShortcut|parseShortcut|CommandOrControl" (src)
  └ 14 lines found

● Check package.json scripts and test frameworks (shell)
  │ cd [REDACTED_REPOSITORY] && cat package.json | grep -A40 '"scripts"' | head -50;
  │ echo "---DEPS---"; grep -iE 'vitest|jest|@testing-library|playwright' package.json || echo "no
  │ JS test frameworks found"
  └ 46 lines…

● Check for existing Rust tests and recent git history (shell)
  │ cd [REDACTED_REPOSITORY] && echo "=== Rust test presence in hotkey-related files
  │ ==="; grep -rn "#\[cfg(test)\]\|#\[test\]" src-tauri/src/commands/ 2>/dev/null | head; echo "===
  │ git log recent ==="; git --no-pager log --oneline -5
  └ 8 lines…

Let me confirm the exact frontend save path (whether it already avoids saving on failure) and the macOS default spec context.

● Read hotkey.ts
  │ src/lib/hotkey.ts
  └ L80:96 (17 lines read)

● Read Settings.tsx
  │ src/routes/Settings.tsx
  └ L568:592 (25 lines read)

I grounded the spec against the actual code. The spec's repo facts are accurate: `set_hotkey` swallows the `"already registered"` error for stale same-app recovery (`hotkey.rs:95-107`), and `Settings.tsx:581` shows the generic `"Couldn't register that shortcut"` toast and already skips saving on failure. It correctly reframes the issue from "override" to "warn + pick another," which matches the researched intent.

## Findings

**Correctness / completeness — NON-BLOCKING**
- The crux (distinguishing genuine Windows cross-app conflict from the stale same-app case) hinges on the exact `RegisterHotKey`/plugin error string, which the spec honestly leaves as Open Question #4. This is researchable during implementation and verifiable in the draft PR — not a blocker.
- Current `set_hotkey` returns `Result<(), String>`; moving to a structured error changes the Tauri error contract. The JS side (`Settings.tsx:582`) currently treats `e` as an `Error`. Tauri serializes `Err(T)` to a plain object, so the frontend parsing must account for that. Spec's section 5 covers this adequately.

**Testing/commands — NON-BLOCKING (worth acting on)**
- `pnpm build` = `tsc && vite build` only builds the frontend and won't compile the Rust changes or run the proposed Rust classification tests. Add `cargo test`/`cargo build` (in `src-tauri`) or `pnpm tauri build` to validation.
- Open Question #3 (frontend harness) is already answered: **vitest** exists (`pnpm test`). Use it for the pure-helper tests.

**Architecture / scope — NON-BLOCKING (advisory)**
- `Onboarding.tsx:531` has an identical "Couldn't register that shortcut" path; for consistency the implementer may update it too (not required by acceptance criteria).
- macOS reserved-list nits: `Command+Q`/`Command+Comma` are app-level, not system-global; the spec already flags them as warning-only/optional, which is appropriately cautious. macOS blocking is pure UX (registration won't fail), which the spec acknowledges.
- Issue cited stale line numbers (`hotkey.rs:103-117`, `Settings.tsx:698-708`); actual are `95-107` / `581`. The spec wisely doesn't hardcode line numbers.

**Security/privacy — GOOD**
- Warn-only; explicitly forbids overriding/unregistering others' shortcuts, enumerating apps, and persisting/logging raw errors or window/app names. No high-blast-radius or authorization-sensitive decision.

## Assessment
Clear objective, explicit acceptance criteria, and named files/components. It reads the issue correctly, contains no unresolvable contradiction (the block-vs-warn macOS question ships with a usable default), and requires no maintainer-only decision. Safety nets (draft PR, agent review, lint/test/build, human merge) cover the open research detail.

SPEC_REVIEW_DECISION: proceed

