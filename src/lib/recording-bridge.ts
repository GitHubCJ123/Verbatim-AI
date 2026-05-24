/**
 * Cross-window recording bridge.
 *
 * Main window calls these helpers; they show/hide the overlay window
 * and emit events that the overlay's React layer listens to. The actual
 * audio capture happens *inside* the overlay window in Phase 2; later
 * phases may move it to Rust if we need lower-level control.
 */
import { emit } from "@tauri-apps/api/event";
import { Window, currentMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

const OVERLAY_LABEL = "overlay";

async function getOverlay(): Promise<Window | null> {
  try {
    const w = Window.getByLabel(OVERLAY_LABEL);
    // Tauri v2: returns Window | null synchronously; Promise tolerated for safety.
    return (await Promise.resolve(w)) ?? null;
  } catch {
    return null;
  }
}

export async function startRecording(modeName = "Default", modeId: string | null = null) {
  const overlay = await getOverlay();
  if (!overlay) return;
  try {
    await positionOverlayBottomCenter(overlay);
  } catch {
    /* best-effort */
  }
  await overlay.show();
  // Emit AFTER show so the listener already exists.
  await emit("recording:start", { modeName, modeId });
}

export async function stopRecording() {
  await emit("recording:stop", {});
}

export async function cancelRecording() {
  await emit("recording:cancel", {});
}

/**
 * Place the overlay 80 px above the taskbar of the monitor the main
 * window currently sits on. Uses the current window's monitor as a
 * proxy because Tauri 2's window API on Windows doesn't expose the
 * cursor's monitor directly.
 */
async function positionOverlayBottomCenter(overlay: Window) {
  const monitor = await currentMonitor();
  if (!monitor) return;
  const overlaySize = await overlay.outerSize();
  const x = monitor.position.x + Math.floor((monitor.size.width - overlaySize.width) / 2);
  const y = monitor.position.y + monitor.size.height - overlaySize.height - 96;
  await overlay.setPosition(new PhysicalPosition(x, y));
}
