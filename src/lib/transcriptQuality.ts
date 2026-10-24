/**
 * Deterministic, always-on transcript hygiene.
 *
 * Two pure steps that guard output quality regardless of engine or Mode:
 *
 *  - {@link sanitizeTranscript} runs on the raw speech-to-text output and
 *    removes well-known ASR artifacts: Whisper's non-speech annotations
 *    ("[BLANK_AUDIO]", "(music)"), the training-data hallucinations it emits
 *    for near-silent clips ("Thanks for watching!"), and decoder repetition
 *    loops ("the the the the the the …").
 *  - {@link finalizeCleanup} runs on the polish LLM's output and strips chat
 *    wrapper text (preambles, quotes, code fences, reasoning blocks). If the
 *    result no longer looks like an edit of the transcript — e.g. a small
 *    model *answered* a dictated question instead of cleaning it up — it
 *    falls back to the transcript, so the user never gets text they didn't
 *    say pasted into their app.
 */

/** Non-speech words whisper wraps in brackets/parentheses/asterisks. */
const NON_SPEECH_WORDS = [
  "blank audio",
  "blank_audio",
  "silence",
  "music",
  "music playing",
  "upbeat music",
  "soft music",
  "applause",
  "laughter",
  "laughs",
  "laughing",
  "inaudible",
  "indistinct",
  "noise",
  "background noise",
  "static",
  "coughs",
  "coughing",
  "sighs",
  "breathing",
  "clears throat",
  "no speech",
  "speaking foreign language",
  "foreign language",
];

const NON_SPEECH_RX = new RegExp(
  String.raw`[\[(*]\s*(?:${NON_SPEECH_WORDS.map((w) => w.replace(/[_ ]/g, "[_ ]")).join("|")})\s*[\])*]`,
  "gi",
);

/**
 * Any short bracketed ALL-CAPS tag ("[MUSIC PLAYING]", "[SOUND]"): users
 * don't dictate square brackets, whisper does emit these.
 */
const BRACKET_TAG_RX = /\[\s*[A-Z][A-Z _-]{1,40}\s*\]/g;

/** Music-note runs ("♪ la la ♪") that whisper emits for background audio. */
const MUSIC_NOTES_RX = /[♪♫]+[^♪♫\n]{0,80}[♪♫]+|[♪♫]+/g;

/**
 * Whole-utterance hallucinations from whisper's YouTube-subtitle training
 * data. Only matched when they are the *entire* transcript, and only phrases
 * nobody plausibly dictates (a lone "Thank you." is deliberately absent).
 */
const WHOLE_HALLUCINATIONS = new Set([
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "thanks for watching and see you next time",
  "please subscribe",
  "like and subscribe",
  "please like and subscribe",
  "dont forget to like and subscribe",
  "subtitles by the amaraorg community",
  "subtitles by amaraorg",
  "transcribed by",
]);

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapse decoder repetition loops: a word repeated 6+ times in a row, or a
 * 2–8 word phrase repeated 4+ times in a row, is reduced to one occurrence.
 * Natural speech ("no, no, no") stays under these thresholds.
 */
export function collapseRepetitions(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 6) return text;
  const key = (t: string) => normalizeForMatch(t);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let collapsed = false;
    for (let n = 8; n >= 1; n--) {
      if (i + n * 2 > tokens.length) continue;
      const minRepeats = n === 1 ? 6 : 4;
      const unit = tokens.slice(i, i + n).map(key);
      if (unit.every((u) => u === "")) continue;
      let repeats = 1;
      while (
        i + (repeats + 1) * n <= tokens.length &&
        tokens
          .slice(i + repeats * n, i + (repeats + 1) * n)
          .every((t, k) => key(t) === unit[k])
      ) {
        repeats++;
      }
      if (repeats >= minRepeats) {
        out.push(...tokens.slice(i, i + n));
        i += repeats * n;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(tokens[i]);
      i++;
    }
  }
  return out.length === tokens.length ? text : out.join(" ");
}

/** Clean ASR artifacts out of a raw transcript. Returns "" for pure noise. */
export function sanitizeTranscript(text: string): string {
  if (!text) return "";
  let out = text
    .replace(NON_SPEECH_RX, " ")
    .replace(BRACKET_TAG_RX, " ")
    .replace(MUSIC_NOTES_RX, " ");
  out = out.replace(/\s+([,.!?;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
  // Leftover punctuation-only output ("." / "-") is noise too.
  if (!/[\p{L}\p{N}]/u.test(out)) return "";
  if (WHOLE_HALLUCINATIONS.has(normalizeForMatch(out))) return "";
  return collapseRepetitions(out);
}

const PREAMBLE_RX =
  /^\s*(?:sure[,!.]?\s*)?(?:here(?:'s| is| are)\s+(?:the|your)\s+[^\n:]{0,60}?:|(?:cleaned|polished|edited|corrected|revised)(?:[ -]up)?\s+(?:text|transcript|version)\s*:|output\s*:)\s*/i;

const THINK_RX = /<think>[\s\S]*?<\/think>/gi;
const TAG_RX = /<\/?(?:transcript|text|output|cleaned)>/gi;

/** Strip wrapper text a chat model put around the cleaned transcript. */
export function stripCleanupWrapper(text: string): string {
  let out = text.replace(THINK_RX, "").replace(TAG_RX, "").trim();
  // Unclosed reasoning block (stream cut or model ignored think:false).
  const openThink = out.search(/<think>/i);
  if (openThink >= 0) out = out.slice(0, openThink).trim();
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) out = fence[1].trim();
  out = out.replace(PREAMBLE_RX, "").trim();
  const quoted = out.match(/^(["“”'])([\s\S]*)(["“”'])$/);
  if (quoted && !out.slice(1, -1).match(/["“”]/)) out = quoted[2].trim();
  return out;
}

export interface FinalizeCleanupOptions {
  /** The Mode translates — output length/words legitimately differ. */
  translating?: boolean;
}

/**
 * Validate and tidy the polish LLM's output, falling back to the transcript
 * when the result is empty or has clearly stopped being an edit of it.
 */
export function finalizeCleanup(
  transcript: string,
  cleaned: string,
  opts: FinalizeCleanupOptions = {},
): { text: string; usedFallback: boolean } {
  const out = stripCleanupWrapper(cleaned);
  if (!out) return { text: transcript, usedFallback: transcript !== "" };
  if (!opts.translating && transcript) {
    // Even expanding Modes (Formal Email, LinkedIn Post) stay within a few
    // times the dictation. Far longer output means the model answered,
    // explained or continued the dictation instead of rewriting it.
    const limit = transcript.length * 4 + 200;
    if (out.length > limit) return { text: transcript, usedFallback: true };
  }
  return { text: out, usedFallback: false };
}
