import { invoke } from "@tauri-apps/api/core";
import { toast } from "../ui/Toast";

/**
 * macOS returns the sentinel string `needs-input-monitoring` when a hotkey
 * that relies on a hardware modifier (fn / right ⌘) can't be registered
 * because the Input Monitoring permission hasn't been granted.
 *
 * This turns that sentinel into a friendly toast and opens the relevant
 * System Settings pane for the user, instead of leaking the raw sentinel
 * string into a generic error toast. Returns `true` when it handled the
 * error, so callers can skip their own generic error toast.
 */
export function handleInputMonitoringError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("needs-input-monitoring")) return false;
  toast.error("Input Monitoring permission needed", {
    description:
      "Verbatim AI needs Input Monitoring to use fn or right ⌘. Opening " +
      "System Settings → Privacy & Security → Input Monitoring — enable " +
      "Verbatim AI there, then relaunch the app and try again.",
  });
  void invoke("open_input_monitoring_settings").catch(() => {});
  return true;
}
