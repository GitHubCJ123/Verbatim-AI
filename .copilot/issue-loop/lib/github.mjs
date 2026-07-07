import { spawnFile } from "./process.mjs";

export async function ghJson(args, options = {}) {
  const result = await spawnFile("gh", args, options);
  if (result.code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export async function gh(args, options = {}) {
  const result = await spawnFile("gh", args, options);
  if (result.code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

export async function listOpenIssues(config) {
  return ghJson([
    "issue",
    "list",
    "--repo",
    config.repository,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,body,labels,assignees,comments,url",
  ]);
}

export async function listOpenPRs(config) {
  return ghJson([
    "pr",
    "list",
    "--repo",
    config.repository,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,headRefName,closingIssuesReferences,isDraft,url",
  ]);
}

export async function issueComments(config, issueNumber) {
  const issue = await ghJson([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    config.repository,
    "--json",
    "comments",
  ]);
  return issue?.comments ?? [];
}

export async function commentIssue(config, issueNumber, body) {
  return gh(["issue", "comment", String(issueNumber), "--repo", config.repository, "--body", body]);
}

export async function commentPR(config, prNumber, body) {
  return gh(["pr", "comment", String(prNumber), "--repo", config.repository, "--body", body]);
}

export async function collaboratorPermission(config, login) {
  const [owner, repo] = config.repository.split("/");
  try {
    const data = await ghJson(["api", `repos/${owner}/${repo}/collaborators/${login}/permission`]);
    return data?.permission ?? "none";
  } catch {
    return "none";
  }
}

export function hasWritePermission(permission) {
  return ["admin", "maintain", "write"].includes(permission);
}
