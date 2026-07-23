import { createHash } from "node:crypto";
import { buildMarker, parseMarkers } from "./markers.mjs";

export function issueInputText(issue) {
  const comments = (issue.comments ?? [])
    .filter((comment) => !parseMarkers(comment.body).some((marker) => marker.kind))
    .map((comment) => `${comment.author?.login ?? "unknown"}: ${comment.body ?? ""}`)
    .join("\n\n");
  return [`# ${issue.title ?? ""}`, issue.body ?? "", comments].join("\n\n").trim();
}

export function issueInputSha(issue) {
  return createHash("sha256").update(issueInputText(issue)).digest("hex");
}

// Deterministic keyword scan used as a HARD safety gate: AI may never downgrade
// a security-sensitive requirements issue to "clear" (see fleet-contract.md
// invariant #4). Erring toward "sensitive" is the safe direction — a false
// positive only keeps the issue on the human path; a false negative could let
// automation proceed on a security-relevant issue. Patterns therefore lean
// liberal and cover the categories in SECURITY_CONCERN_CATEGORIES plus common
// concrete terms (secrets, credentials, auth, permissions, sandbox/exec, RCE,
// filesystem/network, CI, GitHub tokens, code execution).
const SECURITY_SENSITIVE_PATTERNS = [
  /\bsecret(?:s)?\b/i,
  /\bcredential/i,
  /\bpassword|passphrase\b/i,
  /\b(?:api|access|bearer|github|personal[- ]access)\s?tokens?\b/i,
  /\bprivate\s?key\b|\bapi\s?keys?\b/i,
  /\b(?:oauth|jwt|sso|saml)\b/i,
  /authenticat|authori[sz]/i,
  /\brce\b|remote code execution/i,
  /\bssrf\b|\bxss\b|\bcsrf\b|sql\s?injection|command\s?injection/i,
  /\bvulnerabilit|exploit|privilege escalation|sandbox escape\b/i,
  /\bencryption\b|cryptograph/i,
];

export function isSecuritySensitiveIssue(issue) {
  const text = issueInputText(issue ?? {});
  return SECURITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function critiqueRequirements(issue) {
  const body = issue.body ?? "";
  const text = issueInputText(issue);
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name ?? ""))
    .map((name) => name.toLowerCase());
  const findings = [];
  const questions = [];

  const isBug =
    labels.includes("bug") ||
    /\b(bug|crash(?:es|ed|ing)?|regression|broken|does\s?n['’]?t\s+work|not\s+working|stack\s?trace|exception|throws?)\b/i.test(text);
  const isFeatureType = labels.some((label) =>
    ["enhancement", "feature", "design", "proposal", "docs", "documentation", "refactor", "chore", "task"].includes(label),
  );
  // A structured proposal (problem/approach/acceptance/goals/etc.) is enough to
  // draft a spec, regardless of issue type.
  const wellStructured =
    /(?:^|\n)\s*#{1,6}\s*(problem|gap|goal|non[- ]goals?|proposed|proposal|approach|solution|design|scope|acceptance|requirements?|context|why|background|tasks?|plan|summary)\b/i.test(body) ||
    /acceptance criteria|proposed (?:approach|fix|solution|change|design)|non[- ]goals?|success (?:criteria|metric)/i.test(text);

  const hasDiagnostics =
    /https?:\/\/\S+|HTTP status|\b404\b|not found|stack\s?trace|screenshot|attachment|\berror\b|\bexception\b|quota/i.test(text);
  const hasReproContext =
    /(steps?|repro|reproduc|when i|selected|clicked|opened|installed|\b1\.|\b2\.)/i.test(text);
  const substantial = body.trim().length >= 200;

  // Clear-enough to draft a spec if ANY strong signal is present. We lean toward
  // "clear": spec review, adversarial review, and the human PR-merge gate still
  // guard everything downstream, so the requirements gate only stops genuinely
  // empty/ambiguous issues.
  const actionable =
    wellStructured || substantial || hasDiagnostics || (isFeatureType && body.trim().length >= 80);

  if (!actionable) {
    if (body.trim().length < 80) {
      questions.push("Add the outcome you want, who it is for, and how we will know it is done (acceptance criteria).");
    } else if (isBug && !hasReproContext) {
      questions.push("For this bug, add reproduction steps, expected behavior, and observed behavior.");
    } else {
      questions.push("Clarify the concrete change requested and its acceptance criteria.");
    }
  }

  // Narrow secret-handling flag: only when the issue asks to handle REAL
  // credentials/secrets, not merely mentions security topics in a design.
  if (
    /(store|hardcode|hard-code|embed|commit|expose|leak|print|log)\s+(?:a\s+|the\s+|real\s+|production\s+)?(secret|token|credential|password|passphrase|api\s?key|private\s?key)/i.test(text)
  ) {
    questions.push("This appears to require handling real credentials/secrets; a maintainer should scope it manually.");
  }

  if (wellStructured) findings.push("Issue is well-structured (problem/approach/acceptance context present).");
  if (hasDiagnostics) findings.push("Issue includes concrete diagnostic evidence.");
  if (isBug && hasReproContext) findings.push("Bug includes reproduction context.");

  const status = questions.length === 0 ? "clear" : "needs-human";
  return {
    status,
    issueInputSha: issueInputSha(issue),
    issueType: isBug ? "bug" : isFeatureType || wellStructured ? "feature" : "unknown",
    summary:
      status === "clear"
        ? "Requirements are clear enough to draft a spec without a human requirements gate."
        : "Requirements need human clarification before automation should draft a spec.",
    findings,
    questions,
    nextAction:
      status === "clear"
        ? "Proceed to spec drafting. Implementation still requires spec review and approval."
        : "Ask the issue author or maintainer for clarification and apply needs-human.",
  };
}

export function requirementsMarker({ issue, status, issueInputSha, artifactSha }) {
  return buildMarker("requirements", { issue, status, issueInputSha, artifactSha });
}

export function requirementsReview(issue, critique) {
  return [
    `# Requirements review for issue #${issue.number}`,
    "",
    `Status: ${critique.status}`,
    `Issue input SHA: ${critique.issueInputSha}`,
    "",
    "## Summary",
    "",
    critique.summary,
    "",
    "## Findings",
    "",
    ...(critique.findings.length ? critique.findings.map((item) => `- ${item}`) : ["- No concrete findings recorded."]),
    "",
    "## Questions / blockers",
    "",
    ...(critique.questions.length ? critique.questions.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Next action",
    "",
    critique.nextAction,
    "",
    "## Original issue",
    "",
    issue.body ?? "",
    "",
  ].join("\n");
}

export function latestRequirementsMarker(comments = []) {
  return comments
    .flatMap((comment) =>
      parseMarkers(comment.body).map((marker) => ({ ...marker, comment })),
    )
    .filter((marker) => marker.kind === "requirements")
    .at(-1);
}
