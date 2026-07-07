/**
 * Output routing — paste / copy / discard.
 * Plan §14.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { getOutputBehavior } from "./preferences";

const CLIPBOARD_RESTORE_DELAY_MS = 1000;

function restoreClipboardSoon(prev: string, expected: string): void {
  setTimeout(() => {
    void (async () => {
      try {
        const current = await readText();
        if (current === expected) {
          await writeText(prev);
        }
      } catch {
        // If we cannot verify the clipboard still contains our text, do
        // not overwrite whatever the user may have copied in the meantime.
      }
    })();
  }, CLIPBOARD_RESTORE_DELAY_MS);
}

/**
 * Write `text` to the clipboard, then restore focus to the captured
 * target window and simulate Ctrl+V.
 *
 * Output behavior is controlled by Settings -> Recording -> Clipboard behavior.
 */
export async function pasteCleanedText(text: string): Promise<boolean> {
  const behavior = getOutputBehavior();
  if (behavior === "insert-only") {
    try {
      return await invoke<boolean>("insert_text_to_target", { text });
    } catch (e) {
      console.warn("[Verbatim AI] insert_text_to_target failed:", e);
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
    const ok = await invoke<boolean>("paste_to_target");
    if (ok && behavior === "restore" && prev !== null) {
      restoreClipboardSoon(prev, text);
    }
    return ok;
  } catch (e) {
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
