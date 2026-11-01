import React from "react";
import ReactDOM from "react-dom/client";
import Overlay from "./Overlay";
import "../styles/globals.css";
import { installTheme } from "../lib/theme";
import { installUiDiagnostics } from "../lib/diagnostics";

installUiDiagnostics("overlay");
installTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>,
);
