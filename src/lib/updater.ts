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
import { invoke } from "@tauri-apps/api/core";

const RELEASES_URL =
  "https://github.com/GitHubCJ123/Verbatim-AI/releases/latest";

type InstallEnvironment = {
  canAutoInstall: boolean;
  reason: string | null;
  bundlePath: string | null;
};

/**
 * On macOS an unsigned/quarantined app is launched from a read-only App
 * Translocation copy, so tauri's in-place updater would swap that throwaway
 * copy instead of /Applications. Ask the Rust side whether an in-place
 * install can actually land on the real app.
 */
async function getInstallEnvironment(): Promise<InstallEnvironment> {
  try {
    return await invoke<InstallEnvironment>("update_install_environment");
  } catch {
    // If the preflight itself fails, don't block updates.
    return { canAutoInstall: true, reason: null, bundlePath: null };
  }
}

function manualUpdateCopy(
  reason: string | null,
  version: string,
): { headline: string; instructions: string } {
  if (reason === "read_only_volume") {
    return {
      headline: `Verbatim AI ${version} is available. Move the app to your Applications folder to enable updates.`,
      instructions:
        "Verbatim AI is running from a disk image or another read-only location, so it can't update itself in place. Drag Verbatim AI into your Applications folder, launch it from there, then check for updates again.",
    };
  }
  // Default: translocated / quarantined install.
  return {
    headline: `Verbatim AI ${version} is available, but this copy can't update itself (macOS is running it from a quarantined, read-only location).`,
    instructions:
      'macOS is running Verbatim AI from a temporary read-only copy (App Translocation), so the updater cannot replace the app in /Applications. To update: download the latest release below, drag it into Applications (replacing the old app), then run this in Terminal to re-enable automatic updates:\n\nxattr -dr com.apple.quarantine "/Applications/Verbatim AI.app"',
  };
}

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
  | {
      kind: "manual-required";
      version: string;
      currentVersion: string;
      notes?: string;
      reason: string;
      headline: string;
      instructions: string;
      downloadUrl: string;
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
    // Preflight: on macOS a quarantined/translocated or read-only-volume
    // launch can't be updated in place — surface a manual path instead of
    // silently "installing" into a throwaway folder.
    const env = await getInstallEnvironment();
    if (!env.canAutoInstall) {
      const copy = manualUpdateCopy(env.reason, update.version);
      setStatus({
        kind: "manual-required",
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body,
        reason: env.reason ?? "unknown",
        headline: copy.headline,
        instructions: copy.instructions,
        downloadUrl: RELEASES_URL,
      });
      return;
    }
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
  // Defensive: never run the in-place install when it would target a
  // read-only translocated copy instead of /Applications.
  const env = await getInstallEnvironment();
  if (!env.canAutoInstall) {
    throw new Error(
      manualUpdateCopy(env.reason, activeUpdate.version).instructions,
    );
  }
  await activeUpdate.install();
  await relaunch();
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
