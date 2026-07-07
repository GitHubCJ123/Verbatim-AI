import fs from "node:fs/promises";
import path from "node:path";
import { spawnFile } from "./process.mjs";

export async function git(args, cwd) {
  const result = await spawnFile("git", args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

export async function remoteBranchExists(repoCwd, branch) {
  const result = await spawnFile("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], {
    cwd: repoCwd,
  });
  return result.code === 0;
}

export async function ensureRuntimeDir(repoCwd) {
  const dir = path.join(repoCwd, ".copilot-issue-loop");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function changedFiles(cwd, base = "origin/main") {
  const out = await git(["diff", "--name-only", `${base}...HEAD`], cwd);
  return out.split("\n").filter(Boolean);
}

export function hasUiChanges(files) {
  return files.some((file) =>
    /^(src\/(routes|components|overlay|styles)\/|overlay\.html|src\/App\.tsx)/.test(file),
  );
}
