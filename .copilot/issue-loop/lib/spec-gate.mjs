import { createHash } from "node:crypto";
import fs from "node:fs/promises";

// The spec gate is the SINGLE authority for "may this spec proceed to
// implementation". The adversarial review is the EVIDENCE it is based on.
// Durable status lives in phaseStatuses["spec-review"]; the mirrored
// "adversarial-review" status exists only so the dashboard can show the
// reviewer's own outcome.
export const SPEC_GATE_PHASE = "spec-review";
export const SPEC_GATE_EVIDENCE_PHASE = "adversarial-review";

// Bump when the architect/reviewer prompts or gate policy change materially, so
// previously cached "passed" gates are re-reviewed instead of trusted forever.
export const SPEC_GATE_POLICY_VERSION = "2";

export async function fileSha256(file) {
  try {
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

// A gate pass is only reusable while every input that produced it is unchanged:
// the issue text, the spec, the review, and the gate policy itself.
export function specGateFingerprint({ issueInputSha, specSha, reviewSha, policyVersion = SPEC_GATE_POLICY_VERSION }) {
  if (!issueInputSha || !specSha || !reviewSha) return null;
  return createHash("sha256")
    .update([issueInputSha, specSha, reviewSha, policyVersion].join("\n"))
    .digest("hex");
}

export async function computeSpecGateFingerprint({ issueInputSha, specPath, reviewPath }) {
  const [specSha, reviewSha] = await Promise.all([fileSha256(specPath), fileSha256(reviewPath)]);
  return {
    fingerprint: specGateFingerprint({ issueInputSha, specSha, reviewSha }),
    specSha,
    reviewSha,
  };
}

export function readSpecGate(summary) {
  const details = summary?.phaseStatuses?.[SPEC_GATE_PHASE]?.details ?? {};
  const gate = details.gate;
  if (!gate || typeof gate !== "object") return null;
  return gate;
}

// True when a previously recorded gate PASS still matches the current inputs, so
// the spec stage can be skipped and the run resumed at implementation.
export function specGateIsFresh(summary, fingerprint) {
  if (!fingerprint) return false;
  const gate = readSpecGate(summary);
  return Boolean(gate && gate.passed === true && gate.fingerprint === fingerprint);
}

// A hard security veto is monotonic: ordinary "Continue" must never clear it.
// Only an explicit, audited security override (or changed inputs producing a new
// fingerprint) may release it.
export function securityVeto(summary) {
  const gate = readSpecGate(summary);
  if (gate?.securityVeto) {
    return { active: true, reason: gate.vetoReason ?? "Security concern raised during spec review (hard veto).", fingerprint: gate.fingerprint ?? null };
  }
  return { active: false };
}

export function buildGateRecord({ passed, fingerprint, specSha, reviewSha, decision, reason, securityVeto: veto = false, vetoReason = "" }) {
  return {
    passed: Boolean(passed),
    fingerprint: fingerprint ?? null,
    specSha: specSha ?? null,
    reviewSha: reviewSha ?? null,
    decision: decision ?? null,
    reason: String(reason ?? "").slice(0, 600),
    securityVeto: Boolean(veto),
    vetoReason: String(vetoReason ?? "").slice(0, 600),
    policyVersion: SPEC_GATE_POLICY_VERSION,
    at: new Date().toISOString(),
  };
}
