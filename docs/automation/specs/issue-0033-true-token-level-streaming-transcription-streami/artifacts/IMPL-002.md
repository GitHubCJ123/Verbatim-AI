<!-- verbatim-ai:artifact:v1 issue=33 phase=implementation id=issue-0033-issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8-IMPL-002 display=IMPL-002 run=issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8 -->
# IMPL-002: Revision for PR #84

- Issue: #33
- Phase: implementation
- Prefix: IMPL
- Artifact ID: issue-0033-issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8-IMPL-002
- Agent: implementer
- Run: issue-0033-9465be71-f9bf-45d1-aa05-185d0580fdf8
- Created: 2026-07-24T09:01:46.393Z

## Summary

Pushed revision d716637ff472339417c1d9f461ea60ffd1123bf7 addressing agent PR review feedback.

## Body

PR: https://github.com/GitHubCJ123/Verbatim-AI/pull/84
Branch: copilot/issue-33-true-token-level-streaming-transcrip
Head SHA: d716637ff472339417c1d9f461ea60ffd1123bf7

Changed files:
- docs/proposals/streaming-sidecar.md
- src/lib/ai/localWhisper.test.ts
- src/lib/ai/localWhisper.ts
- src/overlay/Overlay.tsx
- src/routes/Settings.tsx

Agent summary:
I'll start by grounding myself in the actual repo state before implementing anything, since the adversarial review flagged a discrepancy about the baseline "live-partial" feature.

● List directory .
  └ 36 files found

● Check repo state and recent history (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && pwd && git status && git log --oneline
  │ -10
  └ 16 lines…

There's already a commit "Implement issue #33 automation spec" and existing `plan.md`/`todo.md` files. Since PR review feedback was "needs-changes", this is likely a revision pass. Let me inspect what was already done.

● Read plan.md
  └ 1 line read

● Read todo.md
  └ 51 lines read

● Show stats of last commit (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git show --stat 4eb7b62 | head -80
  └ 13 lines…

The todo.md mentions issue #33 as already "Validated on macOS" — but the last commit only touched 3 small files. Let me check if there's a fuller streaming implementation already in the codebase from before this worktree, or if that's stale documentation.

● Search git history and files for streaming-related work (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && echo "=== git log --all --oneline |
  │ grep -i stream ===" && git log --all --oneline | grep -i stream | head -30 && echo "=== search
  │ for streaming_transcription files ===" && find . -iname "*streaming*" -not -path
  │ "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" 2>/dev/null
  └ 22 lines…

Significant prior work exists (PRs #43, #45, #46 already merged into this branch's history). Let me examine the current implementation state in detail.

● Read streaming_sidecar.rs
  │ src-tauri/src/commands/streaming_sidecar.rs
  └ 575 lines read

● Read streamingClient.ts
  │ src/lib/transcribe/streamingClient.ts
  └ 170 lines read

● Read streaming-sidecar.md
  │ docs/proposals/streaming-sidecar.md
  └ 277 lines read

Extensive scaffold already exists from earlier merged PRs (#43, #45, #46). Let me check the full integration status: overlay wiring, Rust command registration, settings, and the actual diff from the last commit.

● Show diff of last commit for Settings.tsx (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git show 4eb7b62 --
  │ src/routes/Settings.tsx
  └ 96 lines…

● Show diff of last commit for settings registry and doc (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git show 4eb7b62 --
  │ docs/proposals/streaming-sidecar.md src/lib/settingsRegistry.ts
  └ 66 lines…

● Check Rust command registration for streaming sidecar (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-lev
  │ el-streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && echo "=== main.rs/lib.rs streaming
  │ registration ===" && grep -rn
  │ "streaming_sidecar\|StreamingSidecarState\|start_streaming_session\|push_streaming_frames\|fin
  │ ish_streaming_session\|stop_streaming_session\|is_streaming_sidecar_available" …
  └ 13 lines…

● Check preferences and Overlay wiring for trueStreaming (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && echo "=== preferences.ts trueStreaming
  │ ===" && grep -n "trueStreaming\|TrueStreaming" src/lib/preferences.ts && echo "=== Overlay.tsx
  │ streaming refs ===" && grep -n "streamingClient\|StreamingTranscriber\|trueStreaming\|TrueStream
  │ ing\|isStreamingSidecarAvailable" src/overlay/Overlay.tsx
  └ 16 lines…

Core wiring exists on both sides. Let me check test status, build/lint, and the remaining spec details (fallback UI states, capability model in AIProvider, cleanup-path safety) to find concrete gaps causing "needs-changes."

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ 1 line read

● Count lines in Overlay.tsx (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && wc -l src/overlay/Overlay.tsx
  └ 2 lines…

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ L1:260 (260 lines read)

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ L260:420 (161 lines read)

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ L420:600 (181 lines read)

● Check local_whisper.rs streaming resolve functions (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n
  │ "resolve_streaming_sidecar_launch\|streaming_sidecar_available\|StreamingSidecarLaunch"
  │ src-tauri/src/commands/local_whisper.rs | head -40
  └ 7 lines…

● Check RecordingPill partial text rendering (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && echo "=== RecordingPill partial usage
  │ ===" && grep -n "partialText\|partial" src/components/recording/RecordingPill.tsx | head -40
  └ 9 lines…

● Check sidecars directory and CI workflow for streaming (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && find sidecars -iname "*stream*"
  │ 2>/dev/null && echo "---CI---" && grep -n "whisper-stream\|streaming"
  │ .github/workflows/release.yml | head -40
  └ 44 lines…

● Read RecordingPill.tsx
  │ src/components/recording/RecordingPill.tsx
  └ 183 lines read

● Check whisper-stream.cpp size and AIProvider capability model (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && wc -l
  │ sidecars/whisper-stream/whisper-stream.cpp && echo "---" && grep -n
  │ "capabilities\|streamingTranscription" src/lib/ai/AIProvider.ts src/lib/ai/index.ts
  │ src/lib/ai/localWhisper.ts src/lib/ai/parakeet.ts 2>/dev/null
  └ 3 lines…

● Check package.json scripts (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && cat package.json | grep -A 30
  │ '"scripts"'
  └ 32 lines…

Now let's run the build, lint, and test suite to find concrete failures.

● Run TypeScript type check (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npx tsc --noEmit 2>&1 | tail -60
  └ 1 line…

TypeScript compiles cleanly. Now let's run lint and the test suite.

● Run eslint (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npx eslint . 2>&1 | tail -100
  └ 12 lines…

● Check lint summary and tail (shell)
  │ grep -c "error\|warning" /var/folders/3w/ks19lv9n2d9455t7vswl6y5m0000gn/T/1784882967647-copilot-
  │ tool-output-72687-b0645551-db3d-4753-8cec-c3edd2a8cae6.txt; tail -20
  │ /var/folders/3w/ks19lv9n2d9455t7vswl6y5m0000gn/T/1784882967647-copilot-tool-output-72687-b064555
  │ 1-db3d-4753-8cec-c3edd2a8cae6.txt
  └ 21 lines…

● Check if lint warnings touch streaming files (shell)
  │ grep -B3 "warning\|error" /var/folders/3w/ks19lv9n2d9455t7vswl6y5m0000gn/T/1784882967647-copilot
  │ -tool-output-72687-b0645551-db3d-4753-8cec-c3edd2a8cae6.txt | grep -i
  │ "streaming\|settingsRegistry\|routes/Settings.tsx" | head -20
  └ 3 lines…

Lint is clean (0 errors, pre-existing warnings unrelated to streaming). Now let's run the test suite and Rust checks.

● Run vitest for transcribe module (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npx vitest run src/lib/transcribe 2>&1
  │ | tail -80
  └ 12 lines…

● Run cargo check for Rust backend (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa/src-tauri && cargo check --quiet 2>&1 |
  │ tail -100
  └ 1 line…

● Run Rust tests for streaming_sidecar module (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa/src-tauri && cargo test --quiet
  │ streaming_sidecar 2>&1 | tail -100
  └ 9 lines…

I found a likely architectural gap: `setupTrueStreaming` runs whenever the toggle is on, regardless of which transcription provider is actually active (cloud/Parakeet/local). Let me verify by checking provider selection logic and where the Settings row renders.

● Read index.ts
  │ src/lib/ai/index.ts
  └ 362 lines read

● Read AIProvider.ts
  │ src/lib/ai/AIProvider.ts
  └ 66 lines read

● Check effectiveTranscribeKind implementation (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n
  │ "effectiveTranscribeKind\|getAiProviderKind" -A 15 src/lib/ai/localWhisper.ts | head -60
  └ 34 lines…

● Check localWhisper.ts provider kind types (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n
  │ "effectiveTranscribeKind\|getAiProviderKind\|AiProviderKind\|export type\|export function"
  │ src/lib/ai/localWhisper.ts | head -40
  └ 28 lines…

● List existing test files in src/lib/ai (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && ls src/lib/ai/*.test.ts 2>/dev/null;
  │ echo "---"; ls src/lib/ai/
  └ 28 lines…

● Read localWhisper.test.ts
  │ src/lib/ai/localWhisper.test.ts
  └ L1:60 (57 lines read)

● Find tests referencing index.ts exports (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -rln "from \"\./index\"\|from
  │ \"\.\./ai\"\|getActiveProvider\|effectiveTranscribeKind\|getAiProviderKind" src/lib/ai/*.test.ts
  │ src/lib/**/*.test.ts 2>/dev/null | head -20
  └ 1 line…

● Read localWhisper.ts
  │ src/lib/ai/localWhisper.ts
  └ L1:30 (30 lines read)

● Read localWhisper.ts
  │ src/lib/ai/localWhisper.ts
  └ L160:200 (40 lines read)

● View privacyStatus.ts for the existing override-resolution pattern (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && cat src/lib/privacyStatus.ts
  └ 52 lines…

● Look for privacyStatus test file (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && find src -iname "privacyStatus*"
  └ 2 lines…

● Find tests importing the ai/index module (aggregate) (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && find src -iname "privacyStatus.test.ts"
  │ -o -iname "*.test.ts" | xargs grep -l "from \"\.\./ai\"\|from \"\./ai\"\|from \"\.\./lib/ai\""
  │ 2>/dev/null
  └ 1 line…

● Check vitest config and Mode type (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && cat vitest.config.ts && echo "---mode
  │ type---" && cat src/types/mode.ts | head -40
  └ 55 lines…

● Check test environment setup for localStorage-dependent tests (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "jsdom\|happy-dom\|environment"
  │ package.json vitest.config.ts; echo "---"; find src -iname "preferences*.test.ts"; echo "---";
  │ grep -rln "vitest-environment" src | head -5
  └ 4 lines…

● Read preferences.test.ts
  │ src/lib/preferences.test.ts
  └ L1:50 (49 lines read)

● Read local_whisper.rs
  │ src-tauri/src/commands/local_whisper.rs
  └ L320:420 (101 lines read)

● Check whisper-stream.cpp for real implementation markers (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "int
  │ main\|whisper_full\|params\." sidecars/whisper-stream/whisper-stream.cpp | head -30
  └ 22 lines…

● Check mode.ts imports for circular dependency risk (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "^import\|from \""
  │ src/types/mode.ts
  └ 1 line…

● Check Mode type override fields (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n
  │ "whisperTierOverride\|transcribeProviderOverride\|Override" src/types/mode.ts
  └ 6 lines…

● Check for Overlay tests and override field usage (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && find src/overlay -iname "*.test.*";
  │ echo "---"; grep -n "transcribeProviderOverride\|whisperTierOverride" -r src --include=*.ts
  │ --include=*.tsx | grep -v ".test." | head -20
  └ 22 lines…

Now I have a precise, well-scoped gap: the True Streaming preview ignores which transcription provider is actually active, so it can spin up an unrelated local Whisper sidecar even when Cloud or Parakeet is selected. I'll fix this using the repo's existing `effectiveTranscribeKind` pattern (same one `privacyStatus.ts` already uses), plus respect per-Mode tier overrides. Let me implement.

● Read localWhisper.ts
  │ src/lib/ai/localWhisper.ts
  └ L190:213 (24 lines read)

● Edit localWhisper.ts +17
  └ src/lib/ai/localWhisper.ts

● Edit localWhisper.ts +1
  └ src/lib/ai/localWhisper.ts

Now let's update `Overlay.tsx` to use this gate and respect per-Mode tier overrides:

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ L34:37 (4 lines read)

● Edit Overlay.tsx +1 -1
  └ src/overlay/Overlay.tsx

Now update `setupTrueStreaming` to accept `mode`, resolve the per-Mode tier override, and update its call site:

● Edit Overlay.tsx +12 -1
  └ src/overlay/Overlay.tsx

Now update the call site:

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ L300:317 (18 lines read)

● Edit Overlay.tsx +8 -6
  └ src/overlay/Overlay.tsx

Now let's check the `Mode` import already exists in Overlay.tsx and update the Settings UI description for clarity:

● Confirm Mode type import exists in Overlay.tsx (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "^import type { Mode }"
  │ src/overlay/Overlay.tsx
  └ 2 lines…

● View current TrueStreamingRow implementation (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "TrueStreamingRow" -A 55
  │ src/routes/Settings.tsx | head -60
  └ 61 lines…

● Check Settings.tsx for existing provider-kind usage (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n
  │ "getAiProviderKind\|isLocalWhisperTranscribeActive\|AiProviderKind" src/routes/Settings.tsx |
  │ head -20
  └ 8 lines…

● Read Settings.tsx
  │ src/routes/Settings.tsx
  └ L1:65 (65 lines read)

● Find closing import line for the ai module block (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && sed -n '33,95p' src/routes/Settings.tsx
  │ | grep -n "from \""
  └ 5 lines…

● Read Settings.tsx
  │ src/routes/Settings.tsx
  └ L65:91 (27 lines read)

● Edit Settings.tsx +1
  └ src/routes/Settings.tsx

● Read Settings.tsx
  │ src/routes/Settings.tsx
  └ L409:468 (59 lines read)

● Edit Settings.tsx +13 -4
  └ src/routes/Settings.tsx

● Check localWhisper.test.ts for mocking patterns (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && wc -l src/lib/ai/localWhisper.test.ts
  │ && grep -n "vi.mock\|vi.stubGlobal\|localStorage" src/lib/ai/localWhisper.test.ts
  └ 2 lines…

● Check features.ts for CLOUD_FEATURES_ENABLED definition (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && cat src/lib/features.ts
  └ 23 lines…

● Read localWhisper.test.ts
  │ src/lib/ai/localWhisper.test.ts
  └ 57 lines read

● Edit localWhisper.test.ts +3 -1
  └ src/lib/ai/localWhisper.test.ts

Now let's add the test suite at the end of the file:

● Edit localWhisper.test.ts +57
  └ src/lib/ai/localWhisper.test.ts

● Run localWhisper, preferences, and transcribe tests (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npx vitest run
  │ src/lib/ai/localWhisper.test.ts src/lib/preferences.test.ts src/lib/transcribe 2>&1 | tail -60
  └ 14 lines…

All 13 new tests pass. Now let's run full type-check and lint to confirm no regressions from the Overlay/Settings edits:

● Re-run TypeScript check after edits (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npx tsc --noEmit 2>&1 | tail -60
  └ 1 line…

Clean. Now lint on the specific changed files:

● Lint the changed files (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npx eslint src/overlay/Overlay.tsx
  │ src/routes/Settings.tsx src/lib/ai/localWhisper.ts src/lib/ai/localWhisper.test.ts 2>&1 | tail
  │ -60
  └ 60 lines…

Now let's review the complete diff to ensure everything is coherent, then update the design doc to reflect this fix:

● Show diff stat of all changes so far (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git --no-pager diff --stat
  └ 6 lines…

● Show Overlay.tsx diff (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git --no-pager diff
  │ src/overlay/Overlay.tsx
  └ 68 lines…

This diff is clean and precise. Now let's check the other two diffs:

● Show localWhisper.ts and Settings.tsx diffs (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git --no-pager diff
  │ src/lib/ai/localWhisper.ts src/routes/Settings.tsx
  └ 96 lines…

Now let's update the design doc to document this fix (docs directly related to the change):

● Locate overlay wiring bullet in design doc (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "Overlay.*wires a frame
  │ sink\|only when\|sw.transcribe.trueStreaming === \"1\"" docs/proposals/streaming-sidecar.md
  └ 3 lines…

● Read streaming-sidecar.md
  │ docs/proposals/streaming-sidecar.md
  └ L128:148 (20 lines read)

● Edit streaming-sidecar.md +21 -10
  └ docs/proposals/streaming-sidecar.md

● Locate test plan sections (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "3.2 TS client\|3.3
  │ No-regression" docs/proposals/streaming-sidecar.md
  └ 3 lines…

● Read streaming-sidecar.md
  │ docs/proposals/streaming-sidecar.md
  └ L203:226 (23 lines read)

● Edit streaming-sidecar.md +17 -2
  └ docs/proposals/streaming-sidecar.md

● Read streaming-sidecar.md
  │ docs/proposals/streaming-sidecar.md
  └ L1:10 (10 lines read)

● Edit streaming-sidecar.md +1 -1
  └ docs/proposals/streaming-sidecar.md

Let's run the full validation suite (build, full test suite, full lint) to confirm no regressions anywhere in the repo:

● Run full vitest suite (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npx vitest run 2>&1 | tail -100
  └ 87 lines…

● Run production build (tsc + vite build) (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npm run build 2>&1 | tail -100
  └ 27 lines…

Full suite passes: 269/269 tests, clean production build. Let's do a final full lint pass to confirm zero errors repo-wide:

● Run full lint via npm script (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && npm run lint 2>&1 | tail -15
  └ 15 lines…

● Final git status check (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git status --short && echo
  │ "---diffstat---" && git --no-pager diff --stat
  └ 13 lines…

● Read localWhisper.test.ts
  │ src/lib/ai/localWhisper.test.ts
  └ 116 lines read

This is clean and well-structured. Let's view the final Overlay.tsx section once more in full context to make sure it reads correctly end-to-end:

● Read Overlay.tsx
  │ src/overlay/Overlay.tsx
  └ L164:218 (55 lines read)

This looks correct and complete. Let me do a final check on the whole set of diffs together, and verify the `plan.md`/`todo.md` files don't need updating (checking if they reference this issue in a way that would go stale):

● Check plan.md/todo.md for issue #33 references that might need updating (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && grep -n "issue #33\|#33\b" plan.md
  │ todo.md 2>/dev/null | head -10
  └ 2 lines…

● Check for CHANGELOG conventions (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && find . -maxdepth 1 -iname "CHANGELOG*";
  │ echo "---"; git log --oneline -5 -- CHANGELOG.md 2>/dev/null; echo "---recent PR bodies for
  │ pattern---"; git log -3 --format="%H %s" 2fba4f8
  └ 6 lines…

● Final clean status check (shell)
  │ cd [REDACTED_REPOSITORY]/.copilot-issue-loop/worktrees/issue-33-true-token-level
  │ -streaming-transcrip-issue-0033-9465be71-f9bf-45d1-aa && git status --short
  └ 6 lines…

## Summary

Investigated the existing state: issue #33 already had substantial merged infrastructure (Rust `streaming_sidecar.rs`, TS `streamingClient.ts`, `whisper-stream.cpp` sidecar, CI packaging, Settings toggle) — all build/lint/tests were passing. 

Found the concrete gap behind "needs-changes": the True Streaming preview ignored which transcription provider was actually active, so enabling it while using Cloud or Parakeet would still spin up an unrelated local Whisper sidecar (the missing "provider capability model" the spec's task breakdown called for).

Fixed by adding `isLocalWhisperTranscribeActive()` (reusing the repo's existing `effectiveTranscribeKind` pattern), gating the preview in `Overlay.tsx`, respecting per-Mode tier overrides, updating the Settings badge messaging, adding 7 unit tests, and updating the design doc. Verified: full test suite 269/269 passed, `tsc`+`vite build` clean, lint 0 errors (same pre-existing warning baseline).

IMPLEMENTATION_DECISION: ready


