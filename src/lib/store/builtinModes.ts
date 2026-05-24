import type { Mode } from "../../types/mode";
import { newId, nowIso } from "../../types/mode";

/** Per plan §7 — six built-in Modes seeded on first run. */
export function makeBuiltinModes(): Mode[] {
  const base = (extra: Partial<Mode>): Mode => ({
    id: newId(),
    name: "",
    icon: "Sparkles",
    description: "",
    systemPrompt: "",
    language: "auto",
    targetLanguage: null,
    outputStyle: "paste",
    hotkey: null,
    pushToTalk: true,
    saveHistory: true,
    isBuiltin: true,
    position: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...extra,
  });

  return [
    base({
      name: "Default",
      icon: "Sparkles",
      description: "Universal cleanup. Removes fillers, fixes punctuation, preserves tone.",
      systemPrompt:
        "Make minimal changes. Fix obvious mistakes only. Keep the speaker's word choice.",
      position: 0,
    }),
    base({
      name: "Formal Email",
      icon: "Mail",
      description: "Proper greeting, full sentences, professional vocabulary.",
      systemPrompt:
        "Write as a professional email. Use complete sentences and a polite tone. Add a brief greeting and sign-off only if appropriate context exists in the speech.",
      position: 1,
    }),
    base({
      name: "Slack Message",
      icon: "MessageSquare",
      description: "Casual, contractions ok, light emoji if appropriate.",
      systemPrompt:
        "Keep it casual and concise. Contractions are good. No greetings or sign-offs. A single relevant emoji is okay if it fits naturally.",
      position: 2,
    }),
    base({
      name: "Code Comment",
      icon: "Code",
      description: "Concise, imperative mood, no fluff, wraps around 80 chars.",
      systemPrompt:
        "Write as a short code comment. Use imperative mood. No filler words. Wrap lines around 80 characters.",
      position: 3,
    }),
    base({
      name: "Notes",
      icon: "FileText",
      description: "Bullet-style, brain-dump friendly.",
      systemPrompt:
        "Format as terse bullet points where appropriate. Preserve the raw thinking style.",
      outputStyle: "review",
      position: 4,
    }),
    base({
      name: "Translate → English",
      icon: "Languages",
      description: "Translates any input to natural English.",
      systemPrompt: "Translate to natural, idiomatic English.",
      targetLanguage: "English",
      position: 5,
    }),
  ];
}
