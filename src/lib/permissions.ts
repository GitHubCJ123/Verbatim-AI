/**
 * Permission sentinels emitted by the Rust layer.
 *
 * The native side returns these prefixes as error strings so the UI can
 * turn a raw failure into actionable guidance instead of a generic error.
 * Keep these in sync with the Rust constants:
 *   - `needs-input-monitoring` — src-tauri/src/commands/fn_hotkey.rs
 *   - `needs-accessibility`    — src-tauri/src/commands/accessibility.rs
 */

export const NEEDS_ACCESSIBILITY = "needs-accessibility";
export const TARGET_ACTIVATION_FAILED = "target-activation-failed";

/** True when an error is the macOS Accessibility-permission sentinel. */
export function isAccessibilityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(NEEDS_ACCESSIBILITY);
}

/**
 * True when a paste failed because the captured target window could not be
 * brought to the foreground (so we refused to send input to avoid pasting
 * into our own overlay/review window).
 */
export function isActivationFailedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(TARGET_ACTIVATION_FAILED);
}
