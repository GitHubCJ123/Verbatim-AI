const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b[A-Za-z0-9_]*(?:SERVICE_ROLE|SUPABASE|AZURE|OPENAI|ANTHROPIC|GEMINI|TOKEN|SECRET|KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi,
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
