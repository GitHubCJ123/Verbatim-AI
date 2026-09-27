// Reconciliation: decide whether an issue should START a fresh automation run,
// RESUME an interrupted one, or be SKIPPED.
//
// Why this exists: eligibility intentionally rejects an issue that already has an
// automation branch, an open linked PR, or an active claim, because those signal
// "a run is already underway". That is correct for STARTING a run, but it also
// meant an interrupted run could never continue: the automation's own draft PR
// made its issue permanently ineligible, so the pipeline could only ever finish
// inside a single uninterrupted tick. Anything slower than one tick (a timeout,
// a restart, a crash) stranded the issue forever.
//
// Reconciliation runs BEFORE new-run eligibility and routes such issues to a
// resume instead of dropping them.

export const RESUME_ACTIONS = { START: "start", RESUME: "resume", SKIP: "skip" };

// Phases that mean the run got past the spec stage and owns real work
// (a branch/PR) that a later tick must be able to pick back up.
const IN_FLIGHT_STATUSES = new Set(["ready", "running", "needs-revision", "blocked", "complete", "approved", "recovered"]);

export function hasDurableAutomationState(summary) {
  const statuses = summary?.phaseStatuses ?? {};
  if (Object.keys(statuses).length === 0) return false;
  return Array.isArray(summary?.artifacts) && summary.artifacts.length > 0;
}

// Any PR number recorded by a previous run means real remote work already exists.
export function recordedPrNumber(summary) {
  for (const phase of ["finalization", "verification", "agent-pr-review", "implementation"]) {
    const pr = summary?.phaseStatuses?.[phase]?.details?.prNumber;
    if (Number.isFinite(Number(pr)) && Number(pr) > 0) return Number(pr);
  }
  return null;
}

// A run is resumable when durable state exists and the pipeline has not reached a
// terminal human-owned state (finalization handed off to a human reviewer).
export function reconcileIssue({ summary, stopReason = null, enrolled = true, labels = [], excludedLabels = [] }) {
  if (!enrolled) {
    return { action: RESUME_ACTIONS.SKIP, reason: "Issue is not enrolled in automation." };
  }
  if (stopReason) {
    return { action: RESUME_ACTIONS.SKIP, reason: `Stopped: ${stopReason}` };
  }
  // Exclusion labels are the human kill-switch and must apply to a RESUME exactly as
  // they do to a fresh start; otherwise labelling an in-flight issue "needs-human"
  // or "wontfix" would no longer stop the loop.
  const lower = new Set((labels ?? []).map((l) => String(l).toLowerCase()));
  const hit = (excludedLabels ?? []).find((l) => lower.has(String(l).toLowerCase()));
  if (hit) {
    return { action: RESUME_ACTIONS.SKIP, reason: `Excluded by label ${hit}.` };
  }
  if (!hasDurableAutomationState(summary)) {
    return { action: RESUME_ACTIONS.START, reason: "No durable automation state; start a fresh run." };
  }

  const statuses = summary.phaseStatuses ?? {};
  const status = (phase) => statuses[phase]?.status ?? null;

  // Terminal: the PR is with a human. Nothing for the loop to do.
  if (status("human-pr-review") === "ready" || status("finalization") === "complete") {
    return { action: RESUME_ACTIONS.SKIP, reason: "Waiting on human PR review (terminal for the loop)." };
  }

  // A PR already exists: the remaining phases (agent PR review, verification,
  // finalization) act on that PR. Re-entering processIssue would rebuild the
  // worktree from the base branch and re-run the implementer on top of a PR a
  // human may already be reading, then fail to push (non-fast-forward) and
  // livelock. Until a PR-aware resume exists, leave it to the human.
  const pr = recordedPrNumber(summary);
  if (pr) {
    return { action: RESUME_ACTIONS.SKIP, reason: `Draft PR #${pr} already exists; downstream phases are PR-owned.` };
  }

  const inFlight = ["implementation", "agent-pr-review", "verification", "finalization"].some((phase) =>
    IN_FLIGHT_STATUSES.has(String(status(phase) ?? "")),
  );
  if (inFlight) {
    return { action: RESUME_ACTIONS.RESUME, reason: "Interrupted run has downstream work to continue." };
  }
  return { action: RESUME_ACTIONS.RESUME, reason: "Durable spec-stage state exists; continue that run." };
}
