import { describe, expect, it } from "vitest";
import { canRecoverPhase, computeRecoveryPlan } from "../lib/dashboard.mjs";
import { modelFamily, DEFAULT_CONFIG } from "../lib/config.mjs";
import { rotateNonce, shouldRateLimit } from "../dashboard-server.mjs";

describe("recovery dashboard helpers", () => {
  it("computes a planning-only recovery plan with diverse roster and budget preview", () => {
    const plan = computeRecoveryPlan({ config: DEFAULT_CONFIG, phaseId: "implementation" });

    expect(plan).toMatchObject({
      phaseId: "implementation",
      tiers: ["primary", "sequentialRetry"],
    });
    expect(plan.roster.length).toBeGreaterThanOrEqual(2);
    expect(new Set(plan.roster.map(modelFamily)).size).toBeGreaterThanOrEqual(2);
    expect(plan.budgetPreview.counters.modelCallsPerIssue).toBe(
      DEFAULT_CONFIG.recovery.budgets.maxModelCallsPerIssue,
    );
    expect(plan.note).toMatch(/Planning-only/);
  });

  it("maps the dashboard adversarial-review phase to the spec-review recovery policy", () => {
    const plan = computeRecoveryPlan({ config: DEFAULT_CONFIG, phaseId: "adversarial-review" });

    expect(plan.phaseId).toBe("adversarial-review");
    expect(plan.tiers).toEqual(DEFAULT_CONFIG.recovery.phases["spec-review"].allowedTiers);
    expect(plan.roster).toEqual(DEFAULT_CONFIG.recovery.rosters["spec-review"]);
  });

  it("marks only blocked and needs-human phases as recoverable", () => {
    expect(canRecoverPhase("blocked")).toBe(true);
    expect(canRecoverPhase("needs-human")).toBe(true);
    for (const status of ["ready", "running", "complete", "approved", "needs-revision", "needs-redo", null]) {
      expect(canRecoverPhase(status)).toBe(false);
    }
  });

  it("rotates a single-use nonce on dashboard state", () => {
    const state = {};
    const first = rotateNonce(state);
    const second = rotateNonce(state);

    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(second).toMatch(/^[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
    expect(state.security.nonce).toBe(second);
  });

  it("rate-limits more than once per 3s and more than 10 per minute", () => {
    const map = new Map();
    expect(shouldRateLimit(map, "gh-1:implementation", 1_000)).toBe(false);
    expect(shouldRateLimit(map, "gh-1:implementation", 2_000)).toBe(true);
    for (let i = 1; i < 10; i += 1) {
      expect(shouldRateLimit(map, "gh-1:implementation", 1_000 + i * 3_100)).toBe(false);
    }
    expect(shouldRateLimit(map, "gh-1:implementation", 32_500)).toBe(true);
    expect(shouldRateLimit(map, "gh-1:implementation", 70_000)).toBe(false);
  });

  it("bounds the rate-limit map so distinct keys cannot grow it without limit", () => {
    const map = new Map();
    const base = 1_000_000;
    for (let i = 0; i < 1_100; i += 1) {
      shouldRateLimit(map, `gh-${i}:implementation`, base + i);
    }
    // Sustained distinct-key inserts stay bounded (no unbounded memory growth).
    expect(map.size).toBeLessThanOrEqual(1_000);
    // A request past the window sweeps the now-stale keys back down.
    shouldRateLimit(map, "gh-fresh:implementation", base + 10_000_000);
    expect(map.size).toBeLessThan(50);
  });
});
