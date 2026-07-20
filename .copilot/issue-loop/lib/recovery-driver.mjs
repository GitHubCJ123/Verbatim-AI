// Phase-recovery orchestrators for the local GitHub-issue automation loop.
//
// This module is the WAVE-2 orchestration layer that sits between the driver
// (issue-loop.mjs) and the WAVE-1 substrate (lib/recovery.mjs). Every function
// here is "pure-ish": all impure work (running a model, git, gh, fs) is either
// injected (`runModel`) or left to the driver. That lets the driver unit-test
// recovery without spawning copilot/git/gh.
//
// Safety model (see fleet-contract.md "Security invariants"):
//   * With config.recovery.enabled === false (the default) EVERY orchestrator
//     is a no-op that never calls runModel and never mutates budget/state, so
//     the driver's disabled branch behaves EXACTLY as before.
//   * Gate decisions are deterministic CODE here; the model's JSON only advises.
//   * AI may NEVER downgrade a security-sensitive requirements issue: the
//     `isSecuritySensitive` flag (computed deterministically by the driver) is
//     checked FIRST, before any model vote is consulted.
//   * A security/secret veto from aggregateCouncil() is a hard stop.
//   * Only redacted, bounded SUMMARIES are handed back for persistence — never
//     raw model stdout/stderr/prompts.

import {
  aggregateCouncil,
  beginAttempt,
  buildRoster,
  budgetExhausted,
  completeAttempt,
  emptyRecoveryState,
  nextDiverseModel,
  parseModelDecision,
  recordModelCall,
  requirementsCriticPrompt,
  reserve,
  runCouncil,
  councilVoterPrompt,
  sanitizePriorFailure,
} from "./recovery.mjs";
import { modelFamily } from "./config.mjs";
import { redactSecrets } from "./redaction.mjs";
import { runCopilot } from "./copilot.mjs";

// ---------------------------------------------------------------------------
// Enablement gate
// ---------------------------------------------------------------------------

export function recoveryEnabled(config, phaseId) {
  return (
    config?.recovery?.enabled === true && config?.recovery?.phases?.[phaseId]?.enabled !== false
  );
}

// ---------------------------------------------------------------------------
// Injected model runner factory (driver side; tests pass their own fake)
// ---------------------------------------------------------------------------

// Wrap runCopilot so a recovery model call runs the SAME role with a DIFFERENT
// roster model via modelOverride. Returns the { code, stdout, stderr } shape the
// orchestrators expect. runCopilotFn is injectable purely for tests.
export function makeRunModel(config, worktree, runCopilotFn = runCopilot) {
  return async ({ model, role, prompt }) => {
    const result = await runCopilotFn(config, { role, prompt, worktree, modelOverride: model });
    return {
      code: result?.code ?? 1,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
    };
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function nonNeg(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function safeSummaryText(text, max = 300) {
  return redactSecrets(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, max);
}

function quorumForPhase(config, phaseId) {
  const quorum = config?.recovery?.phases?.[phaseId]?.quorum;
  if (quorum === "all" || quorum === "unanimous" || Number.isInteger(quorum)) return quorum;
  return "majority";
}

// Redacted, bounded summary safe to store in summary.json.phaseStatuses[phase]
// .details.recovery. Contains ONLY counts + deterministic reasons — never raw
// model text (concern text is deliberately excluded from durable persistence).
export function summarizeRecovery(state, decision = {}) {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const last = attempts.length ? attempts[attempts.length - 1] : null;
  return {
    schemaVersion: 1,
    outcome: String(decision.outcome ?? "unknown").slice(0, 40),
    proceed: decision.proceed === true,
    changed: decision.changed === true,
    tier: String(decision.tier ?? last?.tier ?? "none").slice(0, 40),
    reason: safeSummaryText(decision.reason ?? ""),
    vetoReason: decision.vetoReason ? safeSummaryText(decision.vetoReason) : null,
    attempts: attempts.length,
    modelCalls: nonNeg(state?.budgetUsed?.modelCalls, 0),
    concernCount: Array.isArray(decision.concerns) ? decision.concerns.length : 0,
  };
}

// Bounded, already-redacted (by recovery.mjs) clarifying questions extracted from
// council concerns. Safe to post as an issue comment (NOT into summary.json).
export function sharperQuestions(decision, max = 8) {
  const concerns = Array.isArray(decision?.concerns) ? decision.concerns : [];
  return concerns
    .map((concern) => safeSummaryText(concern?.text ?? "", 400))
    .filter(Boolean)
    .slice(0, max);
}

function disabledDecision(phase, { proceedField = false } = {}) {
  return {
    phase,
    tier: "none",
    outcome: "disabled",
    proceed: proceedField,
    requiresHuman: !proceedField,
    changed: false,
    downgraded: false,
    reason: "Phase recovery is disabled; no recovery attempted.",
    concerns: [],
    vetoReason: null,
    recovery: null,
  };
}

// Thin, driver-facing wrapper of recovery.mjs completeAttempt so issue-loop.mjs
// keeps its recovery imports on this module.
export function completeRecoveryAttempt(state, attemptId, { proceed = false, reason = "" } = {}) {
  return completeAttempt(state, attemptId, {
    proceed: proceed === true,
    requiresHuman: proceed !== true,
    reason: safeSummaryText(reason),
  });
}

// ---------------------------------------------------------------------------
// Internal council with an injectable prompt builder
// ---------------------------------------------------------------------------
//
// Mirrors recovery.mjs runCouncil but lets the caller supply a prompt builder so
// the REQUIREMENTS phase can use requirementsCriticPrompt (which frames the
// question as "sharpen this under-specified issue" rather than the generic
// "may automation proceed"). Budget is reserved before EACH call and every call
// is recorded idempotently in state.
async function runCriticCouncil({
  config,
  phaseId,
  role,
  budget,
  state,
  runModel,
  buildPrompt,
  tier,
  priorReasonCode = null,
}) {
  let workingState = state ?? emptyRecoveryState();
  const roster = buildRoster(config, phaseId, {});
  const begun = beginAttempt(workingState, { phase: phaseId, tier, priorReasonCode, roster });
  workingState = begun.state;
  const attemptId = begun.attempt.attemptId;

  const round = reserve(budget, "councilRound");
  if (!round.ok) {
    const decision = {
      proceed: false,
      requiresHuman: true,
      vetoReason: null,
      reason: `council-round budget exhausted (${round.reason ?? "exhausted"}); human review required`,
      votes: { proceed: 0, needsHuman: 0 },
      concerns: [],
    };
    workingState = completeAttempt(workingState, attemptId, decision);
    return { aggregate: decision, state: workingState, incomplete: true };
  }

  const decisions = [];
  let stopReason = null;
  for (let i = 0; i < roster.length; i += 1) {
    if (budgetExhausted(budget)) {
      stopReason = "model/time budget exhausted";
      break;
    }
    const reservation = reserve(budget, "modelCall");
    if (!reservation.ok) {
      stopReason = reservation.reason ?? "model-call budget exhausted";
      break;
    }
    const model = roster[i];
    const family = modelFamily(model);
    const callId = `${attemptId}-${String(i + 1).padStart(2, "0")}`;
    workingState = recordModelCall(workingState, attemptId, {
      callId,
      model,
      family,
      role,
      status: "running",
    });
    let result;
    try {
      result = await runModel({ model, role, prompt: buildPrompt(model, i) });
    } catch (error) {
      result = { code: 1, stdout: "", stderr: String(error) };
    }
    const decision = parseModelDecision(result?.stdout ?? "");
    decisions.push(decision);
    workingState = recordModelCall(workingState, attemptId, {
      callId,
      model,
      family,
      role,
      status: result?.code === 0 ? "complete" : "failed",
      decision,
    });
  }

  const aggregate = aggregateCouncil(decisions, { quorum: quorumForPhase(config, phaseId) });
  let finalAggregate;
  if (aggregate.vetoReason) {
    finalAggregate = { ...aggregate, reason: aggregate.vetoReason };
  } else if (stopReason) {
    finalAggregate = {
      ...aggregate,
      proceed: false,
      requiresHuman: true,
      reason: `council incomplete (${stopReason}); human review required`,
    };
  } else {
    finalAggregate = {
      ...aggregate,
      reason: aggregate.proceed
        ? "council reached quorum to proceed"
        : "council did not reach quorum; human review required",
    };
  }
  workingState = completeAttempt(workingState, attemptId, finalAggregate);
  return { aggregate: finalAggregate, state: workingState, incomplete: Boolean(stopReason) };
}

// ---------------------------------------------------------------------------
// Requirements recovery
// ---------------------------------------------------------------------------

export async function recoverRequirements({
  config,
  issue,
  heuristic = "",
  isSecuritySensitive = false,
  budget,
  state,
  runModel,
} = {}) {
  const phaseId = "requirements";
  let workingState = state ?? emptyRecoveryState();
  if (!recoveryEnabled(config, phaseId)) {
    return { decision: disabledDecision(phaseId), state: workingState };
  }

  const phase = config?.recovery?.phases?.[phaseId] ?? {};
  // Deterministic downgrade eligibility computed in CODE. The model is never
  // trusted to decide this; the prompt is told the same rule for good behavior.
  const allowDowngrade = phase.allowAiDowngrade === true;
  const mayDowngrade = allowDowngrade && !isSecuritySensitive;

  const council = await runCriticCouncil({
    config,
    phaseId,
    role: "requirementsCritic",
    budget,
    state: workingState,
    runModel,
    tier: "requirementsCritic",
    priorReasonCode: "REQUIREMENTS_UNCLEAR",
    buildPrompt: () =>
      requirementsCriticPrompt({
        issue,
        heuristic,
        allowDowngrade: mayDowngrade,
        securitySensitive: isSecuritySensitive,
      }),
  });
  workingState = council.state;
  const aggregate = council.aggregate;

  const councilProceeded = aggregate.proceed === true && !aggregate.vetoReason;
  const downgraded = mayDowngrade && councilProceeded;

  let decision;
  if (downgraded) {
    decision = {
      phase: phaseId,
      tier: "requirementsCritic",
      outcome: "downgraded",
      proceed: true,
      requiresHuman: false,
      changed: true,
      downgraded: true,
      reason:
        "Requirements council reached quorum to proceed; issue is non-security-sensitive and AI downgrade is enabled.",
      concerns: aggregate.concerns ?? [],
      vetoReason: null,
    };
  } else {
    decision = {
      phase: phaseId,
      tier: "requirementsCritic",
      outcome: "needs-human",
      proceed: false,
      requiresHuman: true,
      changed: false,
      downgraded: false,
      reason: requirementsBlockReason({ isSecuritySensitive, allowDowngrade, aggregate }),
      concerns: aggregate.concerns ?? [],
      vetoReason: aggregate.vetoReason ?? null,
    };
  }
  decision.recovery = summarizeRecovery(workingState, decision);
  return { decision, state: workingState };
}

function requirementsBlockReason({ isSecuritySensitive, allowDowngrade, aggregate }) {
  if (isSecuritySensitive) {
    return "Security-sensitive issue: AI may never downgrade requirements to clear; human review required.";
  }
  if (aggregate?.vetoReason) {
    return "Requirements council raised a security veto; human review required.";
  }
  if (!allowDowngrade) {
    return "AI requirements downgrade is disabled by config; council sharpened questions but human review is required.";
  }
  return "Requirements council did not reach quorum to proceed; human review required.";
}

// ---------------------------------------------------------------------------
// Spec-review recovery
// ---------------------------------------------------------------------------

export async function recoverSpecReview({
  config,
  issue,
  specText = "",
  priorFailure = null,
  budget,
  state,
  runModel,
} = {}) {
  const phaseId = "spec-review";
  let workingState = state ?? emptyRecoveryState();
  if (!recoveryEnabled(config, phaseId)) {
    return { decision: disabledDecision(phaseId), state: workingState };
  }

  const phase = config?.recovery?.phases?.[phaseId] ?? {};
  const allowedTiers = Array.isArray(phase.allowedTiers) ? phase.allowedTiers : [];
  // The caller may hand us a raw prior-failure sentence (which can contain
  // untrusted model text). Canonicalize it to a known failure CODE so raw model
  // text never lands in the persisted attempt record (priorReasonCode) or in a
  // prompt; sanitizePriorFailure collapses anything unrecognized to "UNKNOWN".
  const rawPriorCode =
    (typeof priorFailure === "string" ? priorFailure : priorFailure?.failureCode) ?? "SPEC_NEEDS_HUMAN";
  const priorCode = sanitizePriorFailure({ failureCode: rawPriorCode }).failureCode;
  const priorModel = config?.agents?.adversarialReviewer?.model;

  // Tier 1 — diverseRetry: a single reviewer from a DIFFERENT model family.
  if (allowedTiers.includes("diverseRetry")) {
    const retry = await runSingleReviewer({
      config,
      phaseId,
      role: "adversarialReviewer",
      issue,
      artifactText: specText,
      priorFailureCode: priorCode,
      alreadyTried: priorModel ? [priorModel] : [],
      budget,
      state: workingState,
      runModel,
    });
    workingState = retry.state;
    const aggregate = retry.aggregate;
    if (aggregate.vetoReason) {
      return finalizeSpec(workingState, {
        tier: "diverseRetry",
        proceed: false,
        outcome: "veto",
        reason: aggregate.vetoReason,
        vetoReason: aggregate.vetoReason,
        concerns: aggregate.concerns ?? [],
      });
    }
    if (aggregate.proceed === true) {
      return finalizeSpec(workingState, {
        tier: "diverseRetry",
        proceed: true,
        outcome: "proceed",
        changed: true,
        reason: "A diverse-family reviewer cleared the spec with no security veto.",
        concerns: aggregate.concerns ?? [],
      });
    }
    // Not a veto and not a proceed → escalate to the council tier.
  }

  // Tier 2 — council: full roster, deterministic aggregate + security veto.
  if (allowedTiers.includes("council")) {
    const council = await runCouncil({
      config,
      phaseId,
      role: "adversarialReviewer",
      issue,
      artifactText: specText,
      priorFailure: { failureCode: priorCode },
      budget,
      state: workingState,
      runModel,
    });
    workingState = council.state;
    const aggregate = council.decision;
    return finalizeSpec(workingState, {
      tier: "council",
      proceed: aggregate.proceed === true,
      outcome: aggregate.vetoReason ? "veto" : aggregate.proceed ? "proceed" : "needs-human",
      changed: aggregate.proceed === true,
      reason: aggregate.reason ?? (aggregate.proceed ? "Council cleared the spec." : "Council requires human review."),
      vetoReason: aggregate.vetoReason ?? null,
      concerns: aggregate.concerns ?? [],
    });
  }

  return finalizeSpec(workingState, {
    tier: "none",
    proceed: false,
    outcome: "needs-human",
    reason: "No spec-review recovery tiers are enabled; human review required.",
    concerns: [],
  });
}

function finalizeSpec(state, fields) {
  const decision = {
    phase: "spec-review",
    tier: fields.tier ?? "none",
    outcome: fields.outcome ?? (fields.proceed ? "proceed" : "needs-human"),
    proceed: fields.proceed === true,
    requiresHuman: fields.proceed !== true,
    changed: fields.changed === true,
    reason: fields.reason ?? "",
    vetoReason: fields.vetoReason ?? null,
    concerns: fields.concerns ?? [],
  };
  decision.recovery = summarizeRecovery(state, decision);
  return { decision, state };
}

// One reviewer, a different model family from everything already tried. Reserves
// a single modelCall and records the call in state. Aggregated as a one-voter
// council so the SAME security-veto math applies.
async function runSingleReviewer({
  config,
  phaseId,
  role,
  issue,
  artifactText,
  priorFailureCode,
  alreadyTried = [],
  budget,
  state,
  runModel,
}) {
  let workingState = state ?? emptyRecoveryState();
  const roster = buildRoster(config, phaseId, {});
  const begun = beginAttempt(workingState, {
    phase: phaseId,
    tier: "diverseRetry",
    priorReasonCode: priorFailureCode,
    roster,
  });
  workingState = begun.state;
  const attemptId = begun.attempt.attemptId;

  const model = nextDiverseModel(roster, alreadyTried);
  if (!model) {
    const decision = oneVoterBlock("No diverse-family model is available for a spec-review retry.");
    workingState = completeAttempt(workingState, attemptId, decision);
    return { aggregate: decision, state: workingState };
  }
  if (budgetExhausted(budget)) {
    const decision = oneVoterBlock("Model/time budget exhausted before the diverse retry.");
    workingState = completeAttempt(workingState, attemptId, decision);
    return { aggregate: decision, state: workingState };
  }
  const reservation = reserve(budget, "modelCall");
  if (!reservation.ok) {
    const decision = oneVoterBlock(
      `Model-call budget exhausted before the diverse retry (${reservation.reason ?? "exhausted"}).`,
    );
    workingState = completeAttempt(workingState, attemptId, decision);
    return { aggregate: decision, state: workingState };
  }

  const family = modelFamily(model);
  const callId = `${attemptId}-01`;
  workingState = recordModelCall(workingState, attemptId, {
    callId,
    model,
    family,
    role,
    status: "running",
  });
  let result;
  try {
    result = await runModel({
      model,
      role,
      prompt: councilVoterPrompt({
        role,
        issue,
        artifactText,
        priorFailure: { failureCode: priorFailureCode },
      }),
    });
  } catch (error) {
    result = { code: 1, stdout: "", stderr: String(error) };
  }
  const parsed = parseModelDecision(result?.stdout ?? "");
  workingState = recordModelCall(workingState, attemptId, {
    callId,
    model,
    family,
    role,
    status: result?.code === 0 ? "complete" : "failed",
    decision: parsed,
  });

  const aggregate = aggregateCouncil([parsed], { quorum: "majority" });
  const decision = aggregate.vetoReason
    ? { ...aggregate, reason: aggregate.vetoReason }
    : {
        ...aggregate,
        reason: aggregate.proceed
          ? "Diverse-family reviewer voted to proceed."
          : "Diverse-family reviewer did not clear the spec.",
      };
  workingState = completeAttempt(workingState, attemptId, decision);
  return { aggregate: decision, state: workingState };
}

function oneVoterBlock(reason) {
  return {
    proceed: false,
    requiresHuman: true,
    vetoReason: null,
    reason,
    votes: { proceed: 0, needsHuman: 1 },
    concerns: [],
  };
}

// ---------------------------------------------------------------------------
// Implementation recovery — sequential model rotation (git rules stay in driver)
// ---------------------------------------------------------------------------

export function recoverImplementation({ config, alreadyTriedModels = [], budget, state } = {}) {
  const phaseId = "implementation";
  const phase = config?.recovery?.phases?.[phaseId] ?? {};
  // branchStrategy is RETURNED so the driver can enforce git rules; this module
  // never resets, commits, pushes, or force-pushes anything.
  const branchStrategy = phase.branchStrategy ?? "incremental-after-pr";
  // maxAttempts counts TOTAL implementation attempts INCLUDING the primary. The
  // driver seeds alreadyTriedModels with the primary implementer model, so
  // `tried.length >= maxAttempts` bounds the total number of implementer runs.
  const maxAttempts = Number.isInteger(phase.maxAttempts) ? phase.maxAttempts : 2;
  let workingState = state ?? emptyRecoveryState();

  const blocked = (reason) => ({
    nextModel: null,
    branchStrategy,
    attemptId: null,
    exhausted: true,
    reason,
    state: workingState,
  });

  if (!recoveryEnabled(config, phaseId)) return blocked("recovery disabled");
  const tried = Array.isArray(alreadyTriedModels) ? alreadyTriedModels.filter(Boolean) : [];
  if (tried.length >= maxAttempts) {
    return blocked(`max implementation attempts (${maxAttempts}) reached`);
  }
  if (budgetExhausted(budget)) return blocked("model/time budget exhausted");

  const roster = buildRoster(config, phaseId, {});
  const nextModel = nextDiverseModel(roster, tried);
  if (!nextModel) return blocked("implementation roster exhausted");

  const attemptReservation = reserve(budget, "implementationAttempt");
  if (!attemptReservation.ok) {
    return blocked(attemptReservation.reason ?? "implementation-attempt budget exhausted");
  }
  const callReservation = reserve(budget, "modelCall");
  if (!callReservation.ok) {
    return blocked(callReservation.reason ?? "model-call budget exhausted");
  }

  const begun = beginAttempt(workingState, {
    phase: phaseId,
    tier: "sequentialRetry",
    priorReasonCode: "IMPLEMENTATION_BLOCKED",
    roster,
  });
  workingState = begun.state;
  const attemptId = begun.attempt.attemptId;
  workingState = recordModelCall(workingState, attemptId, {
    callId: `${attemptId}-01`,
    model: nextModel,
    family: modelFamily(nextModel),
    role: "implementer",
    status: "running",
  });

  return {
    nextModel,
    branchStrategy,
    attemptId,
    exhausted: false,
    reason: "next implementation model selected",
    state: workingState,
  };
}

// ---------------------------------------------------------------------------
// Verification recovery — repair only. NEVER returns a proceed decision: the
// driver re-runs the REAL verifier, which is authoritative.
// ---------------------------------------------------------------------------

export function recoverVerification({ config, budget, attemptsSoFar = 0, state } = {}) {
  const phaseId = "verification";
  let workingState = state ?? emptyRecoveryState();
  const noRepair = (reason) => ({
    shouldRepair: false,
    model: null,
    attemptId: null,
    reason,
    state: workingState,
  });

  if (!recoveryEnabled(config, phaseId)) return noRepair("recovery disabled");
  const maxRepairs = nonNeg(config?.recovery?.budgets?.maxVerifierRepairAttempts, 2);
  if (attemptsSoFar >= maxRepairs) {
    return noRepair(`max verifier repair attempts (${maxRepairs}) reached`);
  }
  if (budgetExhausted(budget)) return noRepair("model/time budget exhausted");

  const repairReservation = reserve(budget, "verifierRepair");
  if (!repairReservation.ok) {
    return noRepair(repairReservation.reason ?? "verifier-repair budget exhausted");
  }
  const callReservation = reserve(budget, "modelCall");
  if (!callReservation.ok) {
    return noRepair(callReservation.reason ?? "model-call budget exhausted");
  }

  // The repair uses the IMPLEMENTER to FIX the failing lint/test/build. Rotate
  // through the implementation roster across repair attempts for model diversity.
  const roster = buildRoster(config, "implementation", {});
  const model =
    roster.length > 0
      ? roster[attemptsSoFar % roster.length]
      : (config?.agents?.implementer?.model ?? null);

  const begun = beginAttempt(workingState, {
    phase: phaseId,
    tier: "repairOnly",
    priorReasonCode: "VERIFICATION_FAILED",
    roster,
  });
  workingState = begun.state;
  const attemptId = begun.attempt.attemptId;
  workingState = recordModelCall(workingState, attemptId, {
    callId: `${attemptId}-01`,
    model,
    family: model ? modelFamily(model) : null,
    role: "implementer",
    status: "running",
  });

  return {
    shouldRepair: true,
    model,
    attemptId,
    reason: "verifier repair permitted",
    state: workingState,
  };
}
