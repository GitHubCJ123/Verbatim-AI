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
    transcribeProviderOverride: null,
    whisperTierOverride: null,
    cleanupProviderOverride: null,
    ollamaModelOverride: null,
  } as const;

  return [
    {
      ...base,
      id: genId(),
      name: "Default",
      icon: "Sparkles",
      description: "Light cleanup. Fixes fillers and punctuation, preserves tone.",
      systemPrompt:
        "Make minimal changes. Remove disfluencies (\"um\", \"uh\", false starts). Fix obvious grammar and punctuation. Keep the speaker's word choice and tone exactly.",
      outputStyle: "paste",
      position: 0,
    },
    {
      ...base,
      id: genId(),
      name: "Casual",
      icon: "MessageCircle",
      description: "Clear, friendly sentences. No formalities.",
      systemPrompt:
        "Rewrite in clear, conversational sentences. Contractions are good. No greeting or sign-off unless the speaker explicitly said one. Fix grammar and punctuation. Match the speaker's voice.",
      outputStyle: "paste",
      position: 1,
    },
    {
      ...base,
      id: genId(),
      name: "Very Casual",
      icon: "Smile",
      description: "Texting energy — lowercase, minimal punctuation.",
      systemPrompt:
        "Texting-style. Lowercase is fine. Minimal punctuation — no periods at end of single sentences. Slang and contractions encouraged. Keep it short and natural. No greeting or sign-off.",
      outputStyle: "paste",
      position: 2,
    },
    {
      ...base,
      id: genId(),
      name: "Formal",
      icon: "GraduationCap",
      description: "Professional prose. Polished but not email-shaped.",
      systemPrompt:
        "Rewrite as polished, professional prose. Use complete sentences with proper punctuation. Remove all filler words. No contractions. No greeting or sign-off — this is body text only. Preserve the speaker's argument and intent.",
      outputStyle: "paste",
      position: 3,
    },
    {
      ...base,
      id: genId(),
      name: "Formal Email",
      icon: "Mail",
      description: "Full email shape: greeting, body, sign-off.",
      systemPrompt:
        `Rewrite this as a complete formal email.

Structure:
1. Greeting line ("Hi <name>," / "Hello <name>," / "Dear <name>,"). If no recipient was named, use "Hi there,".
2. Blank line.
3. Body in full, professional sentences. Expand fragmented speech into clear prose. Short paragraphs.
4. Blank line.
5. Closing ("Best," / "Thanks," / "Regards,") then the sender's name on its own line — use whatever name the speaker used for themselves.

Do not invent facts. Keep the speaker's intent. Output ONLY the email text — no commentary, no markdown.`,
      outputStyle: "paste",
      position: 4,
    },
    {
      ...base,
      id: genId(),
      name: "Slack Message",
      icon: "MessageSquare",
      description: "Short, casual, optional emoji.",
      systemPrompt:
        "Keep it short and casual. Contractions are good. No greetings or sign-offs. A single relevant emoji at the start or end is okay if it fits naturally; otherwise skip it.",
      outputStyle: "paste",
      position: 5,
    },
    {
      ...base,
      id: genId(),
      name: "Code Comment",
      icon: "Code",
      description: "Imperative, concise, ~80 char wrap.",
      systemPrompt:
        "Write as a code comment. Use imperative mood (\"Fetch the user\", not \"This fetches the user\"). No filler words. Wrap lines around 80 characters. No leading \"//\" or \"#\" — the editor adds those.",
      outputStyle: "paste",
      position: 6,
    },
    {
      ...base,
      id: genId(),
      name: "Notes",
      icon: "NotebookPen",
      description: "Brain-dump friendly. Bullets where they help.",
      systemPrompt:
        "Format as notes. Use short bullets when the speaker is listing things, otherwise short paragraphs. Trim filler words. Keep informal tone. Use Markdown.",
      outputStyle: "review",
      position: 7,
    },
    {
      ...base,
      id: genId(),
      name: "Bullet Points",
      icon: "List",
      description: "Convert speech to a clean bulleted list.",
      systemPrompt:
        "Convert the input into a clean bulleted list using Markdown (\"- \" prefix). One idea per bullet. Sub-bullets (indented) when the speaker clearly nests a thought. Drop filler and connecting words. Sentence fragments are fine if they read clearly.",
      outputStyle: "paste",
      position: 8,
    },
    {
      ...base,
      id: genId(),
      name: "Tweet / X Post",
      icon: "Hash",
      description: "Punchy, under 280 chars, no hashtag spam.",
      systemPrompt:
        "Rewrite as a single X/Twitter post. Keep it under 280 characters total. Punchy, voice-driven, conversational. One or two hashtags max — only if they add value. No \"Thread:\" or numbered prefixes. Output the post text only.",
      outputStyle: "paste",
      position: 9,
    },
    {
      ...base,
      id: genId(),
      name: "LinkedIn Post",
      icon: "Linkedin",
      description: "Professional but warm. Short paragraphs.",
      systemPrompt:
        "Rewrite as a LinkedIn post. Professional but warm. Open with a hook line. Break into short single-sentence paragraphs separated by blank lines. End with a question or call to engagement only if it fits naturally. No hashtags unless the speaker mentioned them.",
      outputStyle: "paste",
      position: 10,
    },
    {
      ...base,
      id: genId(),
      name: "Meeting Note",
      icon: "ClipboardList",
      description: "Action items + decisions, stripped of filler.",
      systemPrompt:
        "Reformat the transcript into a meeting note. Use these sections only when there is content for them: \"## Decisions\", \"## Action items\" (each item starts with \"- [ ] @owner: action\"), \"## Notes\". Drop greetings and small talk. Be terse.",
      outputStyle: "review",
      position: 11,
    },
    {
      ...base,
      id: genId(),
      name: "Translate → English",
      icon: "Languages",
      description: "Translate anything into natural English.",
      systemPrompt:
        "Translate the input into natural, fluent English. Preserve meaning and tone. If the input is already English, just polish it.",
      outputStyle: "paste",
      targetLanguage: "English",
      position: 12,
    },
  ];
}
