/**
 * Output routing — paste / copy / discard.
 * Plan §14.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { osKind } from "./os";
import { pasteMethodUsesClipboard } from "./pasteMethod";
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
 * Paste `text` into the captured target window using the configured method.
 * Clipboard-based methods write `text` to the clipboard before sending the
 * paste shortcut; direct mode types into the target and leaves the clipboard
 * unchanged.
 *
 * Output behavior is controlled by Settings -> Recording.
 */
export async function pasteCleanedText(text: string): Promise<boolean> {
  const behavior = getOutputBehavior();
  const configuredMethod = getPasteMethod();
  const method: PasteMethod = behavior === "insert-only" ? "direct" : configuredMethod;
  const usesClipboard = pasteMethodUsesClipboard(method, osKind());

  if (!usesClipboard) {
    try {
      return await invoke<boolean>("paste_to_target", { text, method });
    } catch (e) {
      console.warn("[Verbatim AI] direct paste failed:", e);
      return false;
    }
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
  try {
    const ok = await invoke<boolean>("paste_to_target", { text: null, method });
    if (behavior === "restore" && prev !== null) {
      if (ok) {
        restoreClipboardSoon(prev, text);
      } else {
        await restoreClipboardIfUnchanged(prev, text, true);
      }
    }
    return ok;
  } catch (e) {
    if (behavior === "restore" && prev !== null) {
      await restoreClipboardIfUnchanged(prev, text, true);
    }
    console.warn("[Verbatim AI] paste_to_target failed:", e);
    return false;
  }
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
