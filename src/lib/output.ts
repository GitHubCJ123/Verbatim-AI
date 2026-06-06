/**
 * Output routing — paste / copy / discard.
 * Plan §14.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { isClipboardRestoreEnabled, isInsertOnlyEnabled } from "./preferences";

const CLIPBOARD_RESTORE_DELAY_MS = 1000;

/**
 * Write `text` to the clipboard, then restore focus to the captured
 * target window and simulate Ctrl+V.
 *
 * If clipboard-restore is enabled, snapshots the user's clipboard
 * before writing and restores it ~1s after paste.
 *
 * If insert-only is enabled, the transcription is pasted but never left on
 * the clipboard: after a successful paste we restore the prior clipboard
 * contents, or clear the clipboard when there were none. When there is no
 * paste target we keep the text on the clipboard as a manual-paste fallback.
 */
export async function pasteCleanedText(text: string): Promise<boolean> {
  const insertOnly = isInsertOnlyEnabled();
  const restore = isClipboardRestoreEnabled();
  // Snapshot the clipboard if we may need to put something back afterwards.
  let prev: string | null = null;
  if (insertOnly || restore) {
    try {
      prev = await readText();
    } catch {
      prev = null;
    }
  }
  await writeText(text);
  try {
    const ok = await invoke<boolean>("paste_to_target");
    if (ok && insertOnly) {
      // Never leave the transcription on the clipboard. Restore the prior
      // contents, or clear it when there was nothing before.
      setTimeout(() => {
        void writeText(prev ?? "").catch(() => {});
      }, CLIPBOARD_RESTORE_DELAY_MS);
    } else if (restore && prev !== null) {
      setTimeout(() => {
        void writeText(prev!).catch(() => {});
      }, CLIPBOARD_RESTORE_DELAY_MS);
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
