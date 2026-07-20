export const EVAL_CODES = {
  STOPPED: "STOPPED",
  MISSING_REQUIRED_LABEL: "MISSING_REQUIRED_LABEL",
  EXCLUDED_LABEL: "EXCLUDED_LABEL",
  OPEN_LINKED_PR: "OPEN_LINKED_PR",
  REMOTE_BRANCH_EXISTS: "REMOTE_BRANCH_EXISTS",
  ACTIVE_CLAIM: "ACTIVE_CLAIM",
};

export function evaluateEligibility({
  config,
  issue,
  openPrs = [],
  remoteBranchExists = false,
  activeClaims = 0,
  stopReason = null,
}) {
  const labels = normalizedLabels(issue?.labels);
  const reasons = [];

  if (stopReason) {
    reasons.push({
      code: EVAL_CODES.STOPPED,
      message: `Automation stopped by ${stopReason}; remove or clear that stop condition before automation can continue.`,
    });
  }

  const requiredLabels = config?.requiredLabels ?? [];
  const missing = requiredLabels.filter((label) => !labels.includes(label));
  if (missing.length) {
    reasons.push({
      code: EVAL_CODES.MISSING_REQUIRED_LABEL,
      message: `Not enrolled: add the ${labelList(missing)} label${missing.length === 1 ? "" : "s"} to let automation implement this issue.`,
    });
  }

  const excludedLabels = config?.excludedLabels ?? [];
  const excluded = labels.filter((label) => excludedLabels.includes(label));
  if (excluded.length) {
    reasons.push({
      code: EVAL_CODES.EXCLUDED_LABEL,
      message: `Excluded from automation by ${labelList(excluded)}; remove the blocking label${excluded.length === 1 ? "" : "s"} to make it eligible.`,
    });
  }

  const linkedOpenPrs = openPrs.filter((pr) => isOpenPr(pr) && prReferencesIssue(pr, issue?.number));
  if (linkedOpenPrs.length) {
    reasons.push({
      code: EVAL_CODES.OPEN_LINKED_PR,
      message: `An open linked PR already exists (${linkedOpenPrs.map((pr) => `#${pr.number}`).join(", ")}); close or merge it before starting another automation run.`,
    });
  }

  if (remoteBranchExists) {
    reasons.push({
      code: EVAL_CODES.REMOTE_BRANCH_EXISTS,
      message: "The automation branch already exists remotely; delete or resolve that branch before starting another run.",
    });
  }

  if (Number(activeClaims) > 0) {
    reasons.push({
      code: EVAL_CODES.ACTIVE_CLAIM,
      message: `${activeClaims} active automation claim${Number(activeClaims) === 1 ? "" : "s"} exist; wait for the claim to expire or be released.`,
    });
  }

  return { eligible: reasons.length === 0, reasons };
}

export function eligibilitySummary(result) {
  if (result?.eligible) return "Eligible";
  return `Ineligible: ${result?.reasons?.[0]?.message ?? "unknown reason"}`;
}

function normalizedLabels(labels = []) {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean);
}

function labelList(labels) {
  return labels.map((label) => `\`${label}\``).join(", ");
}

function isOpenPr(pr) {
  const status = String(pr?.status ?? pr?.state ?? "").toLowerCase();
  if (status === "open" || status === "draft") return true;
  if (pr?.closedAt || pr?.mergedAt) return false;
  return status === "";
}

function prReferencesIssue(pr, issueNumber) {
  if (issueNumber === undefined || issueNumber === null) return true;
  const issue = String(issueNumber);
  return (
    pr?.closingIssuesReferences?.some((ref) => String(ref.number) === issue) ||
    pr?.closingIssues?.some((number) => String(number) === issue) ||
    pr?.relatedIssues?.some((number) => String(number) === issue)
  );
}
