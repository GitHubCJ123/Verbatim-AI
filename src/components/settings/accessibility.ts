import { invoke } from "@tauri-apps/api/core";
import { toast } from "../ui/Toast";
import { isAccessibilityError } from "../../lib/permissions";

/**
 * Show the Accessibility-permission toast and open the settings pane.
 * Callers that already know a permission grant is required (e.g. a
 * `permission-required` paste outcome) can call this directly.
 */
export function notifyAccessibilityRequired(): void {
  toast.error("Accessibility permission needed", {
    description:
      "Verbatim AI needs Accessibility to paste into other apps. Opening " +
      "System Settings → Privacy & Security → Accessibility — enable Verbatim " +
      "AI there, then relaunch the app. Updates can reset this because the app " +
      "isn't code-signed yet.",
  });
  // Register the app in the Accessibility list (and show the system prompt)
  // so there's actually an entry to enable — the silent AXIsProcessTrusted
  // preflight alone never adds it — then open the pane.
  void invoke("request_accessibility_permission").catch(() => {});
  void invoke("open_accessibility_settings").catch(() => {});
}

/**
 * macOS returns the sentinel string `needs-accessibility` when a paste
 * (synthetic ⌘V / direct typing via `enigo`) can't reach the target app
 * because the Accessibility permission hasn't been granted.
 *
 * This turns that sentinel into a friendly toast and opens the relevant
 * System Settings pane, mirroring {@link handleInputMonitoringError}.
 * Returns `true` when it handled the error, so callers can skip their own
 * generic error toast.
 */
export function handleAccessibilityError(err: unknown): boolean {
  if (!isAccessibilityError(err)) return false;
  notifyAccessibilityRequired();
  return true;
}
