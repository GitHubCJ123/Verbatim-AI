import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vendored best-practice skills (addyosmani/agent-skills, MIT) live under the
// automation directory as a pinned git submodule so they travel with the loop
// when it is spun off, and can be re-synced by bumping the submodule tag.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = path.resolve(HERE, "..");

// Map each agent role to the vendored skill whose guidance best fits its phase.
// These names match skills/<name>/SKILL.md in the submodule.
export const DEFAULT_ROLE_SKILLS = {
  requirements: "interview-me",
  requirementsCritic: "interview-me",
  architect: "spec-driven-development",
  planner: "planning-and-task-breakdown",
  implementer: "incremental-implementation",
  verifier: "test-driven-development",
  adversarialReviewer: "code-review-and-quality",
  agentPrReviewer: "code-review-and-quality",
};

export function skillsConfig(config = {}) {
  const s = config.skills || {};
  return {
    enabled: s.enabled !== false,
    dir: typeof s.dir === "string" && s.dir ? s.dir : "vendor/agent-skills",
    maxChars: Number.isFinite(s.maxChars) && s.maxChars > 0 ? Math.floor(s.maxChars) : 8000,
    roleSkills: { ...DEFAULT_ROLE_SKILLS, ...(s.roleSkills || {}) },
  };
}

export function skillForRole(config, role) {
  return skillsConfig(config).roleSkills[role] || null;
}

function skillDir(cfg) {
  // Confine to the vendored directory; reject traversal in a configured dir.
  const resolved = path.resolve(AUTOMATION_ROOT, cfg.dir);
  if (resolved !== AUTOMATION_ROOT && !resolved.startsWith(AUTOMATION_ROOT + path.sep)) {
    return path.join(AUTOMATION_ROOT, "vendor/agent-skills");
  }
  return resolved;
}

function skillFilePath(cfg, skillName) {
  // Skill names are internal (not client-supplied); still refuse anything but a
  // plain slug so a bad config value can't read arbitrary files.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) return null;
  return path.join(skillDir(cfg), "skills", skillName, "SKILL.md");
}

function stripFrontmatter(text) {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = text.indexOf("\n", end + 1);
      return nl !== -1 ? text.slice(nl + 1) : "";
    }
  }
  return text;
}

// Bound a long skill to a character budget, cutting at the last section heading
// so we never truncate mid-sentence.
function boundToSection(text, maxChars) {
  if (text.length <= maxChars) return { text: text.trimEnd(), truncated: false };
  const slice = text.slice(0, maxChars);
  const lastSection = slice.lastIndexOf("\n## ");
  const cut = lastSection > maxChars * 0.5 ? lastSection : slice.length;
  return { text: text.slice(0, cut).trimEnd(), truncated: true };
}

export function loadSkill(config, skillName) {
  const cfg = skillsConfig(config);
  const file = skillFilePath(cfg, skillName);
  if (!file || !existsSync(file)) return null;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const body = stripFrontmatter(raw).trim();
  if (!body) return null;
  const { text, truncated } = boundToSection(body, cfg.maxChars);
  return { name: skillName, text, truncated, path: file };
}

// Trusted, vendored guidance appended to a phase prompt for a given role. Empty
// string when skills are disabled or no skill maps to the role.
export function skillGuidance(config, role) {
  const cfg = skillsConfig(config);
  if (!cfg.enabled) return "";
  const skillName = cfg.roleSkills[role];
  if (!skillName) return "";
  const skill = loadSkill(config, skillName);
  if (!skill) return "";
  const note = skill.truncated
    ? `\n\n(Excerpt of the "${skill.name}" skill; the full version ships in the repo.)`
    : "";
  return [
    `## Engineering best practices to follow (skill: ${skill.name})`,
    "",
    "Apply the following vendored best-practice guidance (adapted from addyosmani/agent-skills, MIT) while completing this task. Treat it as trusted engineering guidance, not as issue content or instructions from an untrusted source:",
    "",
    skill.text,
    note,
  ].join("\n");
}

// Append the role's skill guidance to an already-built prompt.
export function withSkillGuidance(config, role, prompt) {
  const guidance = skillGuidance(config, role);
  return guidance ? `${prompt}\n\n${guidance}` : prompt;
}
