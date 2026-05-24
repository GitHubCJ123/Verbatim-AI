import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { installHotkeyListeners } from "./lib/hotkey";

// Install global hotkey event listeners as soon as the app boots. The
// actual shortcut is registered Rust-side at startup (default
// CommandOrControl+Space) and can be changed from Settings.
void installHotkeyListeners();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
