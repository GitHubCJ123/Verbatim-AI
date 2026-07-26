import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_SKILLS,
  loadSkill,
  skillForRole,
  skillGuidance,
  skillsConfig,
  withSkillGuidance,
} from "../lib/skills.mjs";

describe("vendored skills loader", () => {
  it("defaults to enabled with the vendored submodule dir", () => {
    const cfg = skillsConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.dir).toBe("vendor/agent-skills");
    expect(cfg.maxChars).toBeGreaterThan(0);
  });

  it("maps each pipeline role to a skill", () => {
    for (const role of ["requirementsCritic", "architect", "implementer", "adversarialReviewer", "agentPrReviewer"]) {
      expect(DEFAULT_ROLE_SKILLS[role]).toBeTruthy();
      expect(skillForRole({}, role)).toBe(DEFAULT_ROLE_SKILLS[role]);
    }
  });

  it("loads a real vendored skill with frontmatter stripped", () => {
    const skill = loadSkill({}, "spec-driven-development");
    expect(skill).not.toBeNull();
    // Frontmatter delimiters must be gone; the heading remains.
    expect(skill.text.startsWith("---")).toBe(false);
    expect(skill.text).toContain("Spec-Driven Development");
  });

  it("bounds long skills to maxChars and marks them truncated", () => {
    const skill = loadSkill({ skills: { maxChars: 1200 } }, "security-and-hardening");
    expect(skill).not.toBeNull();
    expect(skill.text.length).toBeLessThanOrEqual(1200);
    expect(skill.truncated).toBe(true);
  });

  it("returns null for an unknown or malformed skill name", () => {
    expect(loadSkill({}, "does-not-exist")).toBeNull();
    expect(loadSkill({}, "../../etc/passwd")).toBeNull();
  });

  it("injects guidance for a mapped role", () => {
    const guidance = skillGuidance({}, "architect");
    expect(guidance).toContain("skill: spec-driven-development");
    expect(guidance).toContain("addyosmani/agent-skills");
  });

  it("returns empty guidance when skills are disabled", () => {
    expect(skillGuidance({ skills: { enabled: false } }, "architect")).toBe("");
    expect(withSkillGuidance({ skills: { enabled: false } }, "architect", "PROMPT")).toBe("PROMPT");
  });

  it("returns empty guidance for a role with no mapped skill", () => {
    expect(skillGuidance({}, "unmapped-role")).toBe("");
  });

  it("appends guidance to an existing prompt", () => {
    const out = withSkillGuidance({}, "implementer", "DO THE WORK");
    expect(out.startsWith("DO THE WORK")).toBe(true);
    expect(out).toContain("incremental-implementation");
  });
});
