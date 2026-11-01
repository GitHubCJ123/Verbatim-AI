import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./styles/globals.css";
import { installTheme } from "./lib/theme";
import { installUiDiagnostics } from "./lib/diagnostics";

installUiDiagnostics("main");
installTheme();
import { installHotkeyListeners } from "./lib/hotkey";
import { toast } from "./components/ui/Toast";
import { installRecordingResultListeners } from "./lib/recordingResults";
import { useAuth } from "./lib/store/useAuth";
import { startRecording as bridgeStart, stopRecording as bridgeStop } from "./lib/recording-bridge";
import { resolveModeAtPress } from "./lib/modeResolver";
import { isHotkeyPaused, setHotkeyPaused } from "./lib/preferences";
import { CLOUD_FEATURES_ENABLED } from "./lib/features";
import type { RecordingErrorRelayPayload } from "./lib/recordingErrors";

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

void installRecordingResultListeners().catch(() => {
  toast.error("Dictation history listener unavailable", {
    description: "Completed text will remain in Review if delivery cannot be confirmed.",
  });
});

void listen<RecordingErrorRelayPayload>("recording:error", (e) => {
  console.error("[Verbatim AI] recording error:", e.payload.kind, e.payload.title);
  toast.error(e.payload.title, {
    description: e.payload.message,
    duration: e.payload.persistent ? 30000 : 10000,
  });
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
