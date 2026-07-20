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
  /secret/i,
  /credential/i,
  /\btokens?\b/i,
  /\b(?:github|access|api|bearer)\s+tokens?\b/i,
  /password|passphrase/i,
  /\bauth\b|authentication|authorization|authori[sz]e|unauthori[sz]ed/i,
  /permission/i,
  /oauth/i,
  /\bjwt\b/i,
  /sandbox/i,
  /\bexec\b|execute|execution|executable/i,
  /\brce\b|remote code execution|code execution/i,
  /file\s?system/i,
  /\bnetwork\b/i,
  /\bssrf\b|\bxss\b|\bcsrf\b|injection/i,
  /\bapi keys?\b/i,
  /private key/i,
  /\bci\b|\bci\/cd\b|continuous integration/i,
];

export function isSecuritySensitiveIssue(issue) {
  const text = issueInputText(issue ?? {});
  return SECURITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function critiqueRequirements(issue) {
  const body = issue.body ?? "";
  const text = issueInputText(issue);
  const findings = [];
  const questions = [];

  if (body.trim().length < 80) {
    questions.push("Please add the exact behavior you expected and what happened instead.");
  }
  if (!/(error|404|not found|expected|actual|steps?|when i|selected|clicked|install|crash|quota|security|leak|bug|fails?)/i.test(text)) {
    questions.push("Please add reproduction steps, expected behavior, and observed behavior.");
  }
  if (/(store|hardcode|add|expose)\s+(a\s+)?(secret|token|credential|password)/i.test(text)) {
    questions.push("This appears to require handling credentials or secrets; a maintainer should scope it manually.");
  }

  if (/https?:\/\/\S+|HTTP status|404|stack|trace|screenshot|attachment/i.test(text)) {
    findings.push("Issue includes concrete diagnostic evidence.");
  }
  if (/\b(1\.|2\.|when|selected|clicked|opened|installed)\b/i.test(text)) {
    findings.push("Issue includes reproduction context.");
  }

  const status = questions.length === 0 ? "clear" : "needs-human";
  return {
    status,
    issueInputSha: issueInputSha(issue),
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
