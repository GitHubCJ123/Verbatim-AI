import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./styles/globals.css";
import { installTheme } from "./lib/theme";

installTheme();
import { installHotkeyListeners } from "./lib/hotkey";
import { toast } from "./components/ui/Toast";
import { addTranscription, type OutputAction } from "./lib/history";
import { useAuth } from "./lib/store/useAuth";
import { startRecording as bridgeStart, stopRecording as bridgeStop } from "./lib/recording-bridge";
import { resolveModeAtPress } from "./lib/modeResolver";
import { loadPreferences, notify, isHotkeyPaused, setHotkeyPaused } from "./lib/preferences";

// Install global hotkey event listeners as soon as the app boots.
void installHotkeyListeners();

// Initialize Supabase auth (no-op if URL/anon key not configured yet).
void useAuth.getState().init();

// Tray menu actions.
let trayRecording = false;
void listen("tray:record", async () => {
  if (isHotkeyPaused()) return;
  if (!trayRecording) {
    const { mode } = await resolveModeAtPress();
    if (!mode) {
      console.warn("[SuperWisper] tray record: no modes available");
      return;
    }
    await bridgeStart(mode.name, mode.id);
    trayRecording = true;
  } else {
    await bridgeStop();
    trayRecording = false;
  }
});

void listen("tray:pause-hotkey", () => {
  const next = !isHotkeyPaused();
  setHotkeyPaused(next);
  toast[next ? "info" : "success"](next ? "Hotkey paused" : "Hotkey resumed");
});

// Track the most recent transcription so review-mode resolution
// (`recording:reviewed`) can attach the final output_action.
interface PendingResult {
  raw: string;
  cleaned: string;
  durationMs: number;
  language: string;
  modeName: string;
  modeId: string | null;
  outputStyle: "paste" | "review";
  saveHistory: boolean;
}
let pending: PendingResult | null = null;

async function persist(result: PendingResult, action: OutputAction, finalCleaned?: string) {
  if (!result.saveHistory) return;
  try {
    await addTranscription({
      modeId: result.modeId,
      modeNameSnap: result.modeName,
      rawText: result.raw,
      cleanedText: finalCleaned ?? result.cleaned,
      audioDurationMs: Math.round(result.durationMs),
      outputAction: action,
      languageDetected: result.language,
    });
  } catch (e) {
    console.warn("[SuperWisper] failed to persist transcript:", e);
  }
}

void listen<PendingResult>("recording:result", async (e) => {
  pending = e.payload;
  toast.success("Transcribed", {
    description: e.payload.cleaned.slice(0, 240),
    duration: 6000,
  });
  if (loadPreferences().notifyOnSuccess) {
    void notify("Transcribed", e.payload.cleaned.slice(0, 240));
  }
  // For auto-paste, persist immediately with action 'pasted' (review
  // mode waits for the user to commit).
  if (e.payload.outputStyle === "paste") {
    await persist(e.payload, "pasted");
    pending = null;
  }
});

void listen<{ action: OutputAction; cleaned: string; modeId: string | null }>(
  "recording:reviewed",
  async (e) => {
    if (!pending) return;
    await persist(pending, e.payload.action, e.payload.cleaned);
    pending = null;
  },
);

void listen<{ message: string; stack?: string }>("recording:error", (e) => {
  console.error("[SuperWisper] recording error:", e.payload.message, e.payload.stack);
  toast.error("Transcription failed", {
    description: e.payload.message,
    duration: 10000,
  });
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
