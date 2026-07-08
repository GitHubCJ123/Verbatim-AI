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
import { isHotkeyPaused, setHotkeyPaused, isHistoryDisabled } from "./lib/preferences";
import { CLOUD_FEATURES_ENABLED } from "./lib/features";

// Install global hotkey event listeners as soon as the app boots.
void installHotkeyListeners();
console.info("[Verbatim AI] main.tsx booted, listeners installing");

// Initialize Supabase auth (no-op if URL/anon key not configured yet).
// Skipped entirely while cloud features are disabled so a build that ships
// with Supabase credentials can't silently restore or background-refresh an
// account session with no in-app way to sign out.
if (CLOUD_FEATURES_ENABLED) {
  void useAuth.getState().init();
}

// Tray menu actions.
let trayRecording = false;
void listen("tray:record", async () => {
  if (isHotkeyPaused()) return;
  if (!trayRecording) {
    const { mode } = await resolveModeAtPress();
    if (!mode) {
      console.warn("[Verbatim AI] tray record: no modes available");
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
  emitId?: string;
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
const handledEmitIds = new Set<string>();

async function persist(result: PendingResult, action: OutputAction, finalCleaned?: string) {
  console.info("[Verbatim AI] persist called", {
    action,
    saveHistory: result.saveHistory,
    modeId: result.modeId,
    modeName: result.modeName,
    cleaned: (finalCleaned ?? result.cleaned).slice(0, 60),
  });
  if (!result.saveHistory) {
    console.warn("[Verbatim AI] persist skipped: saveHistory=false on mode", result.modeName);
    return;
  }
  if (isHistoryDisabled()) {
    console.warn("[Verbatim AI] persist skipped: global history disabled");
    return;
  }
  try {
    const saved = await addTranscription({
      modeId: result.modeId,
      modeNameSnap: result.modeName,
      rawText: result.raw,
      cleanedText: finalCleaned ?? result.cleaned,
      audioDurationMs: Math.round(result.durationMs),
      outputAction: action,
      languageDetected: result.language,
    });
    console.info("[Verbatim AI] persisted transcript id:", saved.id);
  } catch (e) {
    console.warn("[Verbatim AI] failed to persist transcript:", e);
  }
}

void listen<PendingResult>("recording:result", async (e) => {
  if (e.payload.emitId && handledEmitIds.has(e.payload.emitId)) {
    return;
  }
  if (e.payload.emitId) {
    handledEmitIds.add(e.payload.emitId);
    // Keep the set small.
    if (handledEmitIds.size > 50) {
      const first = handledEmitIds.values().next().value;
      if (first) handledEmitIds.delete(first);
    }
  }
  console.info("[Verbatim AI] recording:result received", e.payload.modeName);
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

void listen<{ emitId?: string; action: OutputAction; cleaned: string; modeId: string | null }>(
  "recording:reviewed",
  async (e) => {
    if (e.payload.emitId && handledEmitIds.has(e.payload.emitId)) return;
    if (e.payload.emitId) handledEmitIds.add(e.payload.emitId);
    if (!pending) return;
    await persist(pending, e.payload.action, e.payload.cleaned);
    pending = null;
  },
);

void listen<{ message: string; stack?: string }>("recording:error", (e) => {
  console.error("[Verbatim AI] recording error:", e.payload.message, e.payload.stack);
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
