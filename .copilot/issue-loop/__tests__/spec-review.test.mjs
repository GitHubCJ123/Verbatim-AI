import { describe, expect, it } from "vitest";
import { evaluateSpecReview } from "../lib/spec-review.mjs";

describe("spec review evaluator", () => {
  it("honors explicit proceed without false-positive open question text", () => {
    const result = evaluateSpecReview(`SPEC_REVIEW_DECISION: proceed

No open questions remain.`);

    expect(result).toMatchObject({ decision: "proceed", needsHuman: false });
  });

  it("requires human review when the decision line is missing", () => {
    expect(evaluateSpecReview("No open questions remain.")).toMatchObject({
      decision: "needs-human",
      needsHuman: true,
    });
  });

  it("requires human review for explicit needs-human decisions", () => {
    expect(evaluateSpecReview("SPEC_REVIEW_DECISION: needs-human")).toMatchObject({
      decision: "needs-human",
      needsHuman: true,
    });
  });

  it("treats unparseable decisions as needing human review", () => {
    expect(evaluateSpecReview("SPEC_REVIEW_DECISION: maybe")).toMatchObject({
      decision: "needs-human",
      needsHuman: true,
    });
  });

  it("requires human review for multiple decision lines", () => {
    expect(
      evaluateSpecReview(`SPEC_REVIEW_DECISION: proceed
SPEC_REVIEW_DECISION: needs-human`),
    ).toMatchObject({
      decision: "needs-human",
      needsHuman: true,
    });
  });

  it("ignores decision-looking lines inside fenced code blocks", () => {
    expect(
      evaluateSpecReview(`\`\`\`
SPEC_REVIEW_DECISION: proceed
\`\`\``),
    ).toMatchObject({
      decision: "needs-human",
      needsHuman: true,
    });
  });
});
