/**
 * Output routing — paste / copy / discard.
 * Plan §14.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { osKind } from "./os";
import { pasteMethodUsesClipboard } from "./pasteMethod";
import { isAccessibilityError, isActivationFailedError } from "./permissions";
import { getOutputBehavior, getPasteMethod, type PasteMethod } from "./preferences";

const CLIPBOARD_RESTORE_DELAY_MS = 1000;

async function restoreClipboardIfUnchanged(
  prev: string,
  expected: string,
  restoreOnReadFailure: boolean,
): Promise<void> {
  try {
    const current = await readText();
    if (current === expected) {
      await writeText(prev);
    }
  } catch {
    if (restoreOnReadFailure) {
      await writeText(prev).catch(() => {});
    }
  }
}

function restoreClipboardSoon(prev: string, expected: string): void {
  setTimeout(() => {
    // Delayed restore must not clobber user clipboard activity.
    void restoreClipboardIfUnchanged(prev, expected, false);
  }, CLIPBOARD_RESTORE_DELAY_MS);
}

/**
 * Result of attempting to paste into the captured target window.
 * - `pasted`               — input was dispatched to the target app.
 * - `no-target`            — no target was captured (nothing to paste into).
 * - `permission-required`  — macOS Accessibility isn't granted.
 * - `activation-failed`    — the target couldn't be brought to the front,
 *                            so we refused to send input (avoids self-paste).
 * - `failed`               — any other unexpected failure.
 *
 * Callers branch on this instead of a bare boolean so a missing permission
 * is never silently collapsed into a generic miss.
 */
export type PasteOutcome =
  | "pasted"
  | "no-target"
  | "permission-required"
  | "activation-failed"
  | "failed";

async function invokePaste(args: { text: string | null; method: PasteMethod }): Promise<PasteOutcome> {
  try {
    const ok = await invoke<boolean>("paste_to_target", args);
    return ok ? "pasted" : "no-target";
  } catch (e) {
    if (isAccessibilityError(e)) return "permission-required";
    if (isActivationFailedError(e)) return "activation-failed";
    console.warn("[Verbatim AI] paste_to_target failed:", e);
    return "failed";
  }
}

/**
 * Paste `text` into the captured target window using the configured method.
 * Clipboard-based methods write `text` to the clipboard before sending the
 * paste shortcut; direct mode types into the target and leaves the clipboard
 * unchanged.
 *
 * Output behavior is controlled by Settings -> Recording.
 */
export async function pasteCleanedText(text: string): Promise<PasteOutcome> {
  const behavior = getOutputBehavior();
  const configuredMethod = getPasteMethod();
  const method: PasteMethod = behavior === "insert-only" ? "direct" : configuredMethod;
  const usesClipboard = pasteMethodUsesClipboard(method, osKind());

  if (!usesClipboard) {
    return invokePaste({ text, method });
  }

  let prev: string | null = null;
  if (behavior === "restore") {
    try {
      prev = await readText();
    } catch {
      prev = null;
    }
  }
  await writeText(text);
  const outcome = await invokePaste({ text: null, method });
  if (behavior === "restore" && prev !== null) {
    if (outcome === "pasted") {
      restoreClipboardSoon(prev, text);
    } else {
      await restoreClipboardIfUnchanged(prev, text, true);
    }
  }
  return outcome;
}

export async function copyCleanedText(text: string): Promise<void> {
  await writeText(text);
}

export async function clearCapturedTarget(): Promise<void> {
  try {
    await invoke("clear_target_window");
  } catch {
    /* ignore */
  }
}
