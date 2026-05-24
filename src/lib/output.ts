/**
 * Output routing — paste / copy / discard.
 * Plan §14.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { isClipboardRestoreEnabled } from "./preferences";

const CLIPBOARD_RESTORE_DELAY_MS = 1000;

/**
 * Write `text` to the clipboard, then restore focus to the captured
 * target window and simulate Ctrl+V.
 *
 * If clipboard-restore is enabled, snapshots the user's clipboard
 * before writing and restores it ~1s after paste.
 */
export async function pasteCleanedText(text: string): Promise<boolean> {
  const restore = isClipboardRestoreEnabled();
  let prev: string | null = null;
  if (restore) {
    try {
      prev = await readText();
    } catch {
      prev = null;
    }
  }
  await writeText(text);
  try {
    const ok = await invoke<boolean>("paste_to_target");
    if (restore && prev !== null) {
      setTimeout(() => {
        void writeText(prev!).catch(() => {});
      }, CLIPBOARD_RESTORE_DELAY_MS);
    }
    return ok;
  } catch (e) {
    console.warn("[SuperWisper] paste_to_target failed:", e);
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
