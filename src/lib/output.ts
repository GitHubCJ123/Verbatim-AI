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
 * If insert-only is enabled, the transcription is never retained on the
 * clipboard: we still write + paste (the only reliable cross-app insert
 * path), then put the user's previous clipboard content back — or clear
 * it if there was none — once the paste has landed. If there is no paste
 * target we leave the text on the clipboard as a fallback so it isn't lost.
 */
export async function pasteCleanedText(text: string): Promise<boolean> {
  const insertOnly = isInsertOnlyEnabled();
  const restore = isClipboardRestoreEnabled();
  // Insert-only needs the prior clipboard so it can scrub the transcription
  // afterwards, exactly like the restore path does.
  const snapshot = insertOnly || restore;
  let prev: string | null = null;
  if (snapshot) {
    try {
      prev = await readText();
    } catch {
      prev = null;
    }
  }
  await writeText(text);
  try {
    const ok = await invoke<boolean>("paste_to_target");
    if (insertOnly) {
      if (ok) {
        setTimeout(() => {
          void writeText(prev ?? "").catch(() => {});
        }, CLIPBOARD_RESTORE_DELAY_MS);
      }
      // ok === false → no target captured; keep the text on the clipboard
      // as a fallback rather than losing the transcription.
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
