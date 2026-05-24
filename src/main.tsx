import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./styles/globals.css";
import { installHotkeyListeners } from "./lib/hotkey";
import { toast } from "./components/ui/Toast";
import { addTranscription, type OutputAction } from "./lib/history";
import { useAuth } from "./lib/store/useAuth";

// Install global hotkey event listeners as soon as the app boots. The
// actual shortcut is registered Rust-side at startup (default
// CommandOrControl+Space) and can be changed from Settings.
void installHotkeyListeners();

// Initialize Supabase auth (no-op if URL/anon key not configured yet).
void useAuth.getState().init();

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
