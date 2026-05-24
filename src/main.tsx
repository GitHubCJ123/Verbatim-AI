import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./styles/globals.css";
import { installHotkeyListeners } from "./lib/hotkey";
import { toast } from "./components/ui/Toast";

// Install global hotkey event listeners as soon as the app boots. The
// actual shortcut is registered Rust-side at startup (default
// CommandOrControl+Space) and can be changed from Settings.
void installHotkeyListeners();

// Phase 4 visibility: until paste lands in Phase 7 we show the cleaned
// text in a toast so it's obvious the pipeline ran end-to-end.
void listen<{ raw: string; cleaned: string; modeName: string }>(
  "recording:result",
  (e) => {
    toast.success("Transcribed", {
      description: e.payload.cleaned.slice(0, 240),
      duration: 6000,
    });
  },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
