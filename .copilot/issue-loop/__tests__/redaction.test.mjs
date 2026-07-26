import { describe, expect, it } from "vitest";
import { findSecretLikeText, redactSecrets, truncateForComment } from "../lib/redaction.mjs";

describe("redaction", () => {
  it("redacts common token shapes", () => {
    const text = "token=ghp_1234567890abcdefghijklmnop and AZURE_API_KEY=secret";

    expect(redactSecrets(text)).not.toContain("ghp_1234567890");
    expect(redactSecrets(text)).not.toContain("secret");
    expect(findSecretLikeText(text).length).toBeGreaterThan(0);
  });

  it("truncates long comments after redaction", () => {
    expect(truncateForComment("x".repeat(20), 5)).toContain("[truncated");
  });
});

describe("secret detection precision", () => {
  it("does not flag ordinary identifiers that merely contain key/token", () => {
    // Regression: the old pattern was /[A-Za-z0-9_]*KEY[A-Za-z0-9_]*\s*=\s*\S+/gi,
    // so on a HOTKEY issue it flagged `LS_HOTKEY = "sw.hotkey.spec"` as a secret
    // and blocked a legitimate implementation.
    for (const sample of [
      'const onHotkeyPreferencesChanged = () => {}',
      'const LS_HOTKEY = "sw.hotkey.spec";',
      'let keyCode = event.keyCode;',
      'const hotkey = "Control+Shift+Space";',
      'const tokenizer = new Tokenizer();',
      'let monkey = 1;',
      'key = "a"',
    ]) {
      expect(findSecretLikeText(sample), sample).toHaveLength(0);
    }
  });

  it("still flags real credential assignments", () => {
    for (const sample of [
      'SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9abcdef',
      'const API_KEY = "sk_live_51H8xQ2eZvKYlo2C0abc"',
      'AZURE_API_KEY=secret',
      'password = "hunter2hunter2"',
      'AUTH_TOKEN: "abcdef1234567890abcdef"',
      'MY_SECRET = "s3cr3tvaluethatislong123"',
    ]) {
      expect(findSecretLikeText(sample).length, sample).toBeGreaterThan(0);
    }
  });
});
