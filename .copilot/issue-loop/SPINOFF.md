# Spinning the issue loop off into its own project

The loop is written to be **project-agnostic**: it is native ESM (`.mjs`, Node
22), depends only on Node built-ins + `git`/`gh`, imports nothing from the host
app's `src/`, and lives entirely under this one directory. Everything specific to
Verbatim AI is now config-driven, so it can drive any GitHub repository unchanged.

## What is config-driven (nothing to code-edit per project)

| Concern | Config key | Default |
|---|---|---|
| Target repository | `repository` | `GitHubCJ123/Verbatim-AI` |
| Project name in agent prompts | `projectName` | `Verbatim AI` |
| Base branch | `baseBranch` | `main` |
| Required/excluded labels | `requiredLabels`, `excludedLabels` | `["automate"]` |
| Verification commands | `verification.commands` / `heavyCommands` | pnpm lint/test/build, tauri |
| Verifier command allowlist | `verification.allowedCommandPrefixes` | corepack/pnpm/npm/cargo/git |
| Per-phase best-practice skill | `skills.roleSkills` | agent-skills mapping |
| Models per role | `agents.*.model` | see `config.example.json` |

The dashboard reads `repository` from the merged config (no hardcoded owner/name),
and every phase prompt uses `projectName`. A project written in another stack (e.g.
Python) only needs to set `verification.commands` (e.g. `pytest`) and extend
`verification.allowedCommandPrefixes` (e.g. `"poetry "`, `"go "`); `DENIED_TOKENS`
stay enforced regardless.

## The one structural assumption

`ROOT` (the repository the loop operates on) is derived as two levels up from this
folder — i.e. the loop assumes it is checked in at `<target-repo>/.copilot/issue-loop/`.
Keep that layout when you extract it, or change the two `ROOT` derivations
(`issue-loop.mjs`, `dashboard-server.mjs`) to point at your target checkout.

## Extraction steps

1. **Copy** `.copilot/issue-loop/` into the new project at the same relative
   path (`<repo>/.copilot/issue-loop/`), including the `vendor/agent-skills`
   submodule pin and `.gitmodules` entry.
2. **Config**: copy `config.example.json` to `config.local.json` (gitignored) and
   set `repository`, `projectName`, `baseBranch`, `requiredLabels`,
   `verification.commands`, `verification.allowedCommandPrefixes`, and
   `agents.*.model`.
3. **Skills**: `git submodule update --init .copilot/issue-loop/vendor/agent-skills`
   (see README "Best-practice skills" for re-syncing).
4. **Wire scripts** (optional): mirror the root `package.json` helpers you use
   (`automation:test` -> `vitest run .copilot/issue-loop/__tests__`).
5. **Verify**: `corepack pnpm exec vitest run .copilot/issue-loop/__tests__` and
   `corepack pnpm exec tsc --noEmit` from the new repo root.

## Toward a standalone package

The folder is already a clean unit. To publish it as its own repo/package later:

- Move it to the repo root of a new `copilot-issue-loop` project (adjust the two
  `ROOT` derivations to `process.cwd()` or a `--target` flag).
- Keep `vendor/agent-skills` as a submodule (or convert to an npm dependency if
  upstream publishes one).
- Add a thin `package.json` with the `vitest` devDependency and the
  `automation:test` / dashboard scripts.

No Verbatim-specific source, secrets, or absolute paths are embedded; the only
Verbatim defaults are the config values in the table above.
