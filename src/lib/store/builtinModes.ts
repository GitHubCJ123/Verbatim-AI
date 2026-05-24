/**
 * Built-in mode seed for first-launch local users.
 *
 * Cloud-mode users get these from a Supabase trigger
 * (supabase/migrations/0005_seed_builtin_modes.sql). Local users have
 * no DB, so we materialize the same 6 modes into localStorage on first
 * launch.
 */
import type { Mode } from "../../types/mode";

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildBuiltinModes(): Mode[] {
  const now = new Date().toISOString();
  const base = {
    isBuiltin: true,
    pushToTalk: true,
    saveHistory: true,
    skipCleanup: false,
    hotkey: null,
    targetLanguage: null,
    language: "auto",
    createdAt: now,
    updatedAt: now,
  } as const;

  return [
    {
      ...base,
      id: genId(),
      name: "Default",
      icon: "Sparkles",
      description: "Universal cleanup — fixes grammar, removes fillers, keeps your voice.",
      systemPrompt:
        "Remove disfluencies and fix punctuation/grammar without changing the speaker's intent or tone.",
      outputStyle: "paste",
      position: 0,
    },
    {
      ...base,
      id: genId(),
      name: "Formal Email",
      icon: "Mail",
      description: "Professional tone, proper greeting and sign-off, complete sentences.",
      systemPrompt:
        "Format the text as a professional email. Use complete sentences and formal vocabulary. Do not add a greeting or sign-off unless the speaker provided one.",
      outputStyle: "paste",
      position: 1,
    },
    {
      ...base,
      id: genId(),
      name: "Slack Message",
      icon: "MessageSquare",
      description: "Casual, contractions OK, light emoji if appropriate.",
      systemPrompt:
        "Format as a casual chat message. Contractions are fine. Keep it concise. Light emoji only if the speaker implied tone.",
      outputStyle: "paste",
      position: 2,
    },
    {
      ...base,
      id: genId(),
      name: "Code Comment",
      icon: "Code",
      description: "Concise, imperative mood, no fluff.",
      systemPrompt:
        "Format as a code comment. Be concise. Use imperative mood. No filler.",
      outputStyle: "paste",
      position: 3,
    },
    {
      ...base,
      id: genId(),
      name: "Notes",
      icon: "NotebookPen",
      description: "Bullet points where appropriate, brain-dump friendly.",
      systemPrompt:
        "Format as terse notes. Use bullet points where it makes sense. Preserve all facts.",
      outputStyle: "review",
      position: 4,
    },
    {
      ...base,
      id: genId(),
      name: "Translate → English",
      icon: "Languages",
      description: "Translates any input into natural English.",
      systemPrompt:
        "Translate the transcript into natural English and apply normal cleanup.",
      outputStyle: "paste",
      targetLanguage: "English",
      position: 5,
    },
  ];
}
