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
