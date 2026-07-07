const MARKER_RE = /<!--\s*verbatim-ai:([a-z-]+):v1\s*([^>]*)-->/g;

export function slugify(input, maxLength = 48) {
  const slug = String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "issue";
}

export function issueFolderName(issue) {
  return `issue-${String(issue.number).padStart(4, "0")}-${slugify(issue.title)}`;
}

export function issueBranchName(config, issue) {
  return `${config.branchPrefix}${issue.number}-${slugify(issue.title, 36)}`;
}

export function parseAttrs(raw) {
  const attrs = {};
  const attrRe = /([a-zA-Z0-9_-]+)=("[^"]*"|'[^']*'|[^\s]+)/g;
  let match;
  while ((match = attrRe.exec(raw)) !== null) {
    const value = match[2].replace(/^['"]|['"]$/g, "");
    attrs[match[1]] = value;
  }
  return attrs;
}

export function parseMarkers(text) {
  const markers = [];
  let match;
  while ((match = MARKER_RE.exec(String(text))) !== null) {
    markers.push({ kind: match[1], attrs: parseAttrs(match[2] ?? ""), raw: match[0] });
  }
  return markers;
}

export function buildMarker(kind, attrs) {
  const body = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${quoteAttr(value)}`)
    .join(" ");
  return `<!-- verbatim-ai:${kind}:v1 ${body} -->`;
}

export function claimMarker({ issue, runId, branch, expires }) {
  return buildMarker("claim", { issue, run: runId, branch, expires });
}

export function specMarker({ issue, status, path, sha }) {
  return buildMarker("spec", { issue, status, path, sha });
}

export function specReviewMarker({ issue, status, model }) {
  return buildMarker("spec-review", { issue, status, model });
}

export function specApprovalMarker({ issue, approver, path, sha }) {
  return buildMarker("spec-approval", { issue, approvedBy: approver, path, sha });
}

export function verifyMarker({ pr, issue, head, status }) {
  return buildMarker("verify", { pr, issue, head, status });
}

export function activeClaimsFromComments(comments, now = new Date()) {
  return comments
    .flatMap((comment) =>
      parseMarkers(comment.body).map((marker) => ({ ...marker, author: comment.author?.login })),
    )
    .filter((marker) => marker.kind === "claim")
    .filter((marker) => {
      const expires = Date.parse(marker.attrs.expires ?? "");
      return Number.isFinite(expires) && expires > now.getTime();
    });
}

function quoteAttr(value) {
  const s = String(value);
  return /[\s"']/.test(s) ? JSON.stringify(s) : s;
}
