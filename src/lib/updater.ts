/**
 * Auto-updater bridge.
 *
 * Wraps tauri-plugin-updater into a tiny ergonomic API + an in-memory
 * cache so multiple UI bits (banner + settings page) can subscribe to
 * the same state without each kicking off its own network check.
 *
 * Flow:
 *   1. checkForUpdate() on app launch → if available, downloadInBackground().
 *   2. When download finishes, status flips to "ready" → banner / toast.
 *   3. User clicks Install → installAndRelaunch().
 *   4. User clicks Later → status stays "ready"; banner can be dismissed.
 *      Settings → General shows "Update ready · Install now" button.
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; checkedAt: number }
  | {
      kind: "available";
      version: string;
      currentVersion: string;
      notes?: string;
      downloadedBytes: number;
      totalBytes: number;
    }
  | {
      kind: "downloading";
      version: string;
      currentVersion: string;
      notes?: string;
      downloadedBytes: number;
      totalBytes: number;
    }
  | {
      kind: "ready";
      version: string;
      currentVersion: string;
      notes?: string;
    }
  | { kind: "error"; message: string };

type Listener = (s: UpdateStatus) => void;

let status: UpdateStatus = { kind: "idle" };
let activeUpdate: Update | null = null;
const listeners = new Set<Listener>();

function setStatus(next: UpdateStatus) {
  status = next;
  for (const l of listeners) l(status);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function subscribeUpdateStatus(l: Listener): () => void {
  listeners.add(l);
  l(status);
  return () => {
    listeners.delete(l);
  };
}

export function dismissUpdate(): void {
  // Keep `activeUpdate` so Install Now still works from Settings.
  // We just reset visual state. Caller is responsible for hiding their UI.
}

/** Kicks off a check; safe to call multiple times. */
export async function checkForUpdate(): Promise<void> {
  if (status.kind === "checking" || status.kind === "downloading") return;
  setStatus({ kind: "checking" });
  try {
    const update = await check();
    if (!update) {
      setStatus({ kind: "up-to-date", checkedAt: Date.now() });
      return;
    }
    activeUpdate = update;
    setStatus({
      kind: "available",
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body,
      downloadedBytes: 0,
      totalBytes: 0,
    });
    // Auto-download in the background. The user gets to choose
    // when to install / restart.
    await downloadInBackground();
  } catch (e) {
    setStatus({ kind: "error", message: errMsg(e) });
  }
}

async function downloadInBackground(): Promise<void> {
  if (!activeUpdate) return;
  if (status.kind === "ready") return;
  let downloaded = 0;
  let total = 0;
  setStatus({
    kind: "downloading",
    version: activeUpdate.version,
    currentVersion: activeUpdate.currentVersion,
    notes: activeUpdate.body,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  try {
    await activeUpdate.download((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (activeUpdate) {
            setStatus({
              kind: "downloading",
              version: activeUpdate.version,
              currentVersion: activeUpdate.currentVersion,
              notes: activeUpdate.body,
              downloadedBytes: downloaded,
              totalBytes: total,
            });
          }
          break;
        case "Finished":
          if (activeUpdate) {
            setStatus({
              kind: "ready",
              version: activeUpdate.version,
              currentVersion: activeUpdate.currentVersion,
              notes: activeUpdate.body,
            });
          }
          break;
      }
    });
  } catch (e) {
    setStatus({ kind: "error", message: errMsg(e) });
  }
}

export async function installAndRelaunch(): Promise<void> {
  if (!activeUpdate) throw new Error("No update queued.");
  await activeUpdate.install();
  await relaunch();
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
