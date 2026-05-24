/**
 * Cross-window recording bridge.
 *
 * Main window calls these helpers; they show/hide the overlay window
 * and emit events that the overlay's React layer listens to. The actual
 * audio capture happens *inside* the overlay window in Phase 2; later
 * phases may move it to Rust if we need lower-level control.
 */
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Window, currentMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

const OVERLAY_LABEL = "overlay";

const OVERLAY_PILL_SIZE = { width: 420, height: 96 };
const OVERLAY_REVIEW_SIZE = { width: 520, height: 360 };

async function getOverlay(): Promise<Window | null> {
  try {
    const w = Window.getByLabel(OVERLAY_LABEL);
    return (await Promise.resolve(w)) ?? null;
  } catch {
    return null;
  }
}

export async function startRecording(modeName = "Default", modeId: string | null = null) {
  const overlay = await getOverlay();
  if (!overlay) return;

  // Capture the foreground window *before* showing the overlay, so we
  // can paste back into it. The overlay has `focus: false` so showing
  // it shouldn't steal focus — but Windows isn't always cooperative,
  // and capturing first is the safest pattern (plan §14).
  try {
    await invoke("capture_target_window");
  } catch {
    /* ignore */
  }

  try {
    await overlay.setSize(new PhysicalSize(OVERLAY_PILL_SIZE.width, OVERLAY_PILL_SIZE.height));
    await positionOverlayBottomCenter(overlay);
  } catch {
    /* best-effort */
  }
  await overlay.show();
  await emit("recording:start", { modeName, modeId });
}

export async function stopRecording() {
  await emit("recording:stop", {});
}

export async function cancelRecording() {
  await emit("recording:cancel", {});
}

export async function resizeOverlayToReview() {
  const overlay = await getOverlay();
  if (!overlay) return;
  await overlay.setSize(
    new PhysicalSize(OVERLAY_REVIEW_SIZE.width, OVERLAY_REVIEW_SIZE.height),
  );
  await positionOverlayBottomCenter(overlay);
}

export async function resizeOverlayToPill() {
  const overlay = await getOverlay();
  if (!overlay) return;
  await overlay.setSize(
    new PhysicalSize(OVERLAY_PILL_SIZE.width, OVERLAY_PILL_SIZE.height),
  );
  await positionOverlayBottomCenter(overlay);
}

async function positionOverlayBottomCenter(overlay: Window) {
  const monitor = await currentMonitor();
  if (!monitor) return;
  const overlaySize = await overlay.outerSize();
  const x = monitor.position.x + Math.floor((monitor.size.width - overlaySize.width) / 2);
  const y = monitor.position.y + monitor.size.height - overlaySize.height - 96;
  await overlay.setPosition(new PhysicalPosition(x, y));
}
