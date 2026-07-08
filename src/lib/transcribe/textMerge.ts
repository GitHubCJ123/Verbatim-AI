function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Stitch a rolling-window partial onto the preview already shown in the UI.
 *
 * Batch local engines can only return whole-window text, so after the
 * segmenter switches from full-context to rolling windows we de-duplicate the
 * overlap by matching the previous suffix against the next prefix.
 */
export function mergeRollingPartialText(previous: string, nextWindow: string): string {
  const previousClean = previous.trim();
  const nextClean = nextWindow.trim();
  if (!previousClean) return nextClean;
  if (!nextClean) return previousClean;

  if (nextClean.startsWith(previousClean)) return nextClean;
  if (previousClean.startsWith(nextClean)) return previousClean;

  const prevWords = words(previousClean);
  const nextWords = words(nextClean);
  const maxOverlap = Math.min(32, prevWords.length, nextWords.length);

  for (let size = maxOverlap; size > 0; size--) {
    const prevSuffix = prevWords.slice(prevWords.length - size).map(normalizeWord);
    const nextPrefix = nextWords.slice(0, size).map(normalizeWord);
    if (prevSuffix.every((word, i) => word !== "" && word === nextPrefix[i])) {
      return [...prevWords, ...nextWords.slice(size)].join(" ");
    }
  }

  return `${previousClean} ${nextClean}`;
}
