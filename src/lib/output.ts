/**
 * Output routing — paste / copy / discard.
 * Plan §14.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Write `text` to the clipboard, then restore focus to the captured
 * target window and simulate Ctrl+V.
 *
 * Returns true if a target was captured and the keystroke was sent;
 * false if there was no captured target (the text is still on the
 * clipboard so the user can paste manually).
 */
export async function pasteCleanedText(text: string): Promise<boolean> {
  await writeText(text);
  try {
    const ok = await invoke<boolean>("paste_to_target");
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
