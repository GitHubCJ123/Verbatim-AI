import { invoke } from "@tauri-apps/api/core";
import { toast } from "../ui/Toast";
import {
  isAccessibilityError,
  PASTE_PERMISSION_GUIDANCE,
  PASTE_PERMISSION_SETTINGS_PATH,
} from "../../lib/permissions";

export async function openPastePermissionSettings(): Promise<void> {
  await invoke("request_accessibility_permission");
  await invoke("open_accessibility_settings");
}

/**
 * Explain the permission with an explicit action to open the settings pane.
 * Callers that already know a permission grant is required (e.g. a
 * `permission-required` paste outcome) can call this directly.
 */
export function notifyAccessibilityRequired(): void {
  toast.info("Allow typing into other apps", {
    description: PASTE_PERMISSION_GUIDANCE,
    duration: Infinity,
    action: {
      label: "Open Settings",
      onClick: () => {
        void openPastePermissionSettings().catch(() => {
          toast.error("Couldn't open permission settings", {
            description: `Open ${PASTE_PERMISSION_SETTINGS_PATH} manually, then enable Verbatim AI.`,
            duration: Infinity,
          });
        });
      },
    },
  });
}

/**
 * macOS returns the sentinel string `needs-accessibility` when a paste
 * (synthetic ⌘V / direct typing via `enigo`) can't reach the target app
 * because the Accessibility permission hasn't been granted.
 *
 * This turns that sentinel into guidance with a System Settings action.
 * Returns `true` when it handled the error, so callers can skip their own
 * generic error toast.
 */
export function handleAccessibilityError(err: unknown): boolean {
  if (!isAccessibilityError(err)) return false;
  notifyAccessibilityRequired();
  return true;
}
