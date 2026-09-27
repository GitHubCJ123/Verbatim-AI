const SECRET_PATTERNS = [
  // Name-based patterns run FIRST so a full `NAME=value` assignment is replaced as
  // one unit (otherwise the value is redacted first and the name is left dangling).
  // Tier 1 - unambiguous credential names: flag any assigned value. The sensitive
  // word must be a whole name component (SNAKE_CASE segment or word boundary), so
  // ordinary identifiers that merely contain the letters (hotkey, keyboard, monkey)
  // never match. The value excludes spaces/parens so `= () => {}` is not a "secret".
  /\b[A-Za-z0-9]*(?:_|\b)(?:SERVICE_ROLE|SUPABASE|AZURE|OPENAI|ANTHROPIC|GEMINI|API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PASSWD)(?:_[A-Za-z0-9]+)*\s*[:=]\s*["'`]?[A-Za-z0-9_\-./+=]{3,}["'`]?/gi,
  // Tier 2 - generic names (TOKEN/SECRET/KEY/CREDENTIAL) only count when the value
  // itself looks like a credential: a long opaque literal. This keeps
  // `const hotkey = "Control+Shift+Space"` and `key = "a"` out of the results.
  /\b[A-Za-z0-9]*(?:_|\b)(?:TOKEN|SECRET|CREDENTIALS?|KEY)(?:_[A-Za-z0-9]+)*\s*[:=]\s*["'`]?[A-Za-z0-9_\-./+=]{16,}["'`]?/gi,
  // Bare token shapes, wherever they appear.
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
];

export function redactSecrets(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function findSecretLikeText(text) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(String(text))) findings.push(pattern.toString());
  }
  return findings;
}

export function truncateForComment(text, max = 12000) {
  const redacted = redactSecrets(text);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}\n\n[truncated ${redacted.length - max} chars]`;
}
