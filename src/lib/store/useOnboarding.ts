/**
 * Onboarding state + auto-generation logic (plan §15).
 *
 * Stores the user's selections in localStorage so the flow is
 * resumable. When the user reaches Step 7, we materialize:
 *   - one Mode per unique tone choice
 *   - one app_mapping per picked app pointing at its tone's Mode
 */
import { create } from "zustand";
import { useModes } from "./useModes";
import { useAppMappings } from "./useAppMappings";
import { useAuth } from "./useAuth";

function progressKey() {
  const uid = useAuth.getState().user?.id ?? "anon";
  return `sw.onboarding.${uid}`;
}

export type Tone = "formal" | "casual" | "very_casual" | "custom";

export interface OnboardingAppPick {
  exe: string;
  displayName: string;
  defaultTone: Tone;
}

export const COMMON_APPS: OnboardingAppPick[] = [
  { exe: "slack.exe", displayName: "Slack", defaultTone: "casual" },
  { exe: "discord.exe", displayName: "Discord", defaultTone: "very_casual" },
  { exe: "teams.exe", displayName: "Microsoft Teams", defaultTone: "formal" },
  { exe: "olk.exe", displayName: "Outlook", defaultTone: "formal" },
  { exe: "telegram.exe", displayName: "Telegram", defaultTone: "very_casual" },
  { exe: "signal.exe", displayName: "Signal", defaultTone: "casual" },
  { exe: "whatsapp.exe", displayName: "WhatsApp", defaultTone: "casual" },
  { exe: "code.exe", displayName: "VS Code", defaultTone: "casual" },
  { exe: "cursor.exe", displayName: "Cursor", defaultTone: "casual" },
  { exe: "idea64.exe", displayName: "JetBrains IDE", defaultTone: "casual" },
  { exe: "notion.exe", displayName: "Notion", defaultTone: "casual" },
  { exe: "obsidian.exe", displayName: "Obsidian", defaultTone: "casual" },
  { exe: "chrome.exe", displayName: "Chrome (browser)", defaultTone: "casual" },
  { exe: "msedge.exe", displayName: "Edge (browser)", defaultTone: "casual" },
  { exe: "firefox.exe", displayName: "Firefox (browser)", defaultTone: "casual" },
];

export const TONE_LABEL: Record<Tone, string> = {
  formal: "Formal",
  casual: "Casual",
  very_casual: "Very Casual",
  custom: "Custom",
};

interface OnboardingState {
  step: number;
  completed: boolean;
  micPermission: "unknown" | "granted" | "denied";
  hotkey: string;
  pushToTalk: boolean;
  picks: Record<string, boolean>;     // exe → selected
  tones: Record<string, Tone>;        // exe → tone
  customTone: string;                  // free-text used when tone === "custom"
  setStep: (n: number) => void;
  next: () => void;
  back: () => void;
  togglePick: (exe: string) => void;
  setTone: (exe: string, t: Tone) => void;
  setCustomTone: (s: string) => void;
  setHotkey: (s: string) => void;
  setPushToTalk: (v: boolean) => void;
  setMicPermission: (v: "granted" | "denied") => void;
  finish: () => void;
  reset: () => void;
}

function loadProgress(): { step: number; completed: boolean } {
  try {
    const raw = localStorage.getItem(progressKey());
    if (!raw) return { step: 0, completed: false };
    const j = JSON.parse(raw) as { step?: number; completed?: boolean };
    return { step: j.step ?? 0, completed: Boolean(j.completed) };
  } catch {
    return { step: 0, completed: false };
  }
}

function saveProgress(step: number, completed: boolean) {
  localStorage.setItem(progressKey(), JSON.stringify({ step, completed }));
}

const defaultPicks: Record<string, boolean> = {};
const defaultTones: Record<string, Tone> = {};
for (const a of COMMON_APPS) {
  defaultPicks[a.exe] = false;
  defaultTones[a.exe] = a.defaultTone;
}

const TOTAL_STEPS = 13;

export const useOnboarding = create<OnboardingState>((set, get) => {
  const initial = loadProgress();
  return {
    step: initial.step,
    completed: initial.completed,
    micPermission: "unknown",
    hotkey: "CommandOrControl+Space",
    pushToTalk: true,
    picks: defaultPicks,
    tones: defaultTones,
    customTone: "",
    setStep: (n) => {
      const clamped = Math.max(0, Math.min(TOTAL_STEPS - 1, n));
      saveProgress(clamped, get().completed);
      set({ step: clamped });
    },
    next: () => get().setStep(get().step + 1),
    back: () => get().setStep(get().step - 1),
    togglePick: (exe) =>
      set((s) => ({ picks: { ...s.picks, [exe]: !s.picks[exe] } })),
    setTone: (exe, t) =>
      set((s) => ({ tones: { ...s.tones, [exe]: t } })),
    setCustomTone: (s) => set({ customTone: s }),
    setHotkey: (s) => set({ hotkey: s }),
    setPushToTalk: (v) => set({ pushToTalk: v }),
    setMicPermission: (v) => set({ micPermission: v }),
    finish: () => {
      saveProgress(TOTAL_STEPS - 1, true);
      set({ completed: true });
    },
    reset: () => {
      localStorage.removeItem(progressKey());
      set({ step: 0, completed: false });
    },
  };
});

export function isOnboardingComplete(): boolean {
  return loadProgress().completed;
}

// ─── Auto-generation ────────────────────────────────────────────────────

const TONE_SYSTEM_PROMPTS: Record<Tone, { name: string; description: string; prompt: string }> = {
  formal: {
    name: "Formal",
    description: "Full email shape: greeting, body, sign-off.",
    prompt: `Rewrite this as a complete formal email.

Structure:
1. Greeting line ("Hi <name>," / "Hello <name>," / "Dear <name>,"). If no recipient was named, use "Hi there,".
2. Blank line.
3. Body in full, professional sentences. Expand fragmented speech into clear prose. Short paragraphs.
4. Blank line.
5. Closing ("Best," / "Thanks," / "Regards,") then the sender's name on its own line — use whatever name the speaker used for themselves.

Do not invent facts. Keep the speaker's intent. Output ONLY the email text — no commentary, no markdown.`,
  },
  casual: {
    name: "Casual",
    description: "Clear sentences, friendly tone, no formalities.",
    prompt:
      "Rewrite in clear, conversational sentences. Contractions are good. No greeting or sign-off unless the speaker explicitly said one. Fix grammar and punctuation. Keep it natural — match the speaker's voice.",
  },
  very_casual: {
    name: "Very Casual",
    description: "Texting energy — minimal punctuation, lowercase OK.",
    prompt:
      "Texting-style. Lowercase is fine. Minimal punctuation — no periods at end of single sentences. Slang and contractions encouraged. Keep it short and natural. No greeting or sign-off.",
  },
  custom: {
    name: "Custom",
    description: "User-defined tone.",
    prompt: "",
  },
};

/**
 * Materialize the user's picks into Modes + app_mappings.
 *  - One Mode per unique tone (with the Custom tone's free-text appended).
 *  - One app_mapping per picked app, pointing at its tone's Mode.
 *
 * Idempotent-ish: re-running onboarding adds NEW modes/mappings rather
 * than upserting. Users can clean up from the Modes/Apps pages.
 */
export async function applyOnboarding(): Promise<{ modesCreated: number; mappingsCreated: number }> {
  const state = useOnboarding.getState();
  const modesStore = useModes.getState();
  const mappingsStore = useAppMappings.getState();

  const pickedExes = Object.entries(state.picks)
    .filter(([, v]) => v)
    .map(([exe]) => exe);

  const usedTones = new Set<Tone>();
  for (const exe of pickedExes) usedTones.add(state.tones[exe] ?? "casual");

  const toneToModeId = new Map<Tone, string>();
  let modesCreated = 0;

  for (const tone of usedTones) {
    const spec = TONE_SYSTEM_PROMPTS[tone];
    const prompt =
      tone === "custom" && state.customTone
        ? state.customTone
        : spec.prompt;
    if (!prompt) continue;
    const m = await modesStore.create({
      name: spec.name,
      description: spec.description,
      systemPrompt: prompt,
      icon: tone === "formal" ? "Mail" : tone === "very_casual" ? "MessageSquare" : "Sparkles",
    });
    toneToModeId.set(tone, m.id);
    modesCreated += 1;
  }

  let mappingsCreated = 0;
  for (const exe of pickedExes) {
    const tone = state.tones[exe] ?? "casual";
    const modeId = toneToModeId.get(tone) ?? null;
    const pick = COMMON_APPS.find((a) => a.exe === exe);
    if (!pick) continue;
    await mappingsStore.add({
      appExecutable: exe,
      appDisplayName: pick.displayName,
      modeId,
    });
    mappingsCreated += 1;
  }

  state.finish();
  return { modesCreated, mappingsCreated };
}
