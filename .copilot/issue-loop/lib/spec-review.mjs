export function evaluateSpecReview(reviewText) {
  const text = String(reviewText ?? "");
  const decisionLines = topLevelLines(text)
    .map((line) => line.match(/^SPEC_REVIEW_DECISION:\s*(.*?)\s*$/i))
    .filter(Boolean);

  if (decisionLines.length === 0) {
    return {
      decision: "needs-human",
      needsHuman: true,
      reason: "Missing SPEC_REVIEW_DECISION line.",
    };
  }

  if (decisionLines.length > 1) {
    return {
      decision: "needs-human",
      needsHuman: true,
      reason: "Multiple SPEC_REVIEW_DECISION lines found.",
    };
  }

  const decisionLine = decisionLines[0];
  const decision = decisionLine[1].toLowerCase();
  if (decision === "proceed") {
    return {
      decision,
      needsHuman: false,
      reason: "Explicit SPEC_REVIEW_DECISION: proceed.",
    };
  }

  if (decision === "needs-human") {
    return {
      decision,
      needsHuman: true,
      reason: "Explicit SPEC_REVIEW_DECISION: needs-human.",
    };
  }

  return {
    decision: "needs-human",
    needsHuman: true,
    reason: `Unparseable SPEC_REVIEW_DECISION: ${decisionLine[1] || "(empty)"}.`,
  };
}

function topLevelLines(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let inFence = false;
  return lines.filter((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return false;
    }
    return !inFence;
  });
}
