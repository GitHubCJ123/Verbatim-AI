/**
 * Cross-window recording bridge.
 *
 * Main window calls these helpers; they show/hide the overlay window
 * and emit events that the overlay's React layer listens to. The actual
 * audio capture happens *inside* the overlay window in Phase 2; later
 * phases may move it to Rust if we need lower-level control.
 */
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  Window,
  availableMonitors,
  currentMonitor,
  cursorPosition,
  monitorFromPoint,
  type Monitor,
} from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { loadOverlayPosition } from "./preferences";

const OVERLAY_LABEL = "overlay";

const OVERLAY_PILL_SIZE = { width: 420, height: 96 };
const OVERLAY_REVIEW_SIZE = { width: 520, height: 360 };

// Tauri events are fire-and-forget — if the overlay's React listener
// isn't mounted yet when `recording:start` is emitted, the event is
// silently dropped and the overlay stays idle. The overlay emits
// `overlay:ready` from its mount effect; we cache the first one and
// gate `startRecording` on it.
let overlayReady = false;
let overlayReadyResolve: (() => void) | null = null;
const overlayReadyPromise = new Promise<void>((resolve) => {
  overlayReadyResolve = resolve;
});
listen("overlay:ready", () => {
  overlayReady = true;
  overlayReadyResolve?.();
}).catch(() => {
  /* ignore */
});

async function waitForOverlayReady(timeoutMs = 3000): Promise<void> {
  if (overlayReady) return;
  await Promise.race([
    overlayReadyPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

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

  // Latency is the product: tell the overlay to open the mic FIRST.
  // The overlay window exists hidden and can run getUserMedia before it
  // is visible, so audio capture doesn't wait on window chrome
  // (docs/improvement-plan/04-performance-latency.md, Fix 1).
  await waitForOverlayReady();
  const audioStarted = emit("recording:start", { modeName, modeId });

  // Window chrome runs concurrently with mic acquisition. Within this
  // chain the order still matters: capture the foreground window
  // *before* showing the overlay so we can paste back into it (plan §14).
  const chrome = (async () => {
    try {
      await invoke("capture_target_window");
    } catch {
      /* ignore */
    }
    try {
      const targetMonitor = await getCursorMonitor();
      await overlay.setSize(new PhysicalSize(OVERLAY_PILL_SIZE.width, OVERLAY_PILL_SIZE.height));
      await positionOverlay(overlay, targetMonitor);
    } catch {
      /* best-effort */
    }
    await overlay.show();
  })();

  await Promise.all([audioStarted, chrome]);
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
  const monitor = await currentMonitor();
  await overlay.setSize(
    new PhysicalSize(OVERLAY_REVIEW_SIZE.width, OVERLAY_REVIEW_SIZE.height),
  );
  await positionOverlay(overlay, monitor);
}

export async function resizeOverlayToPill() {
  const overlay = await getOverlay();
  if (!overlay) return;
  const monitor = await currentMonitor();
  await overlay.setSize(
    new PhysicalSize(OVERLAY_PILL_SIZE.width, OVERLAY_PILL_SIZE.height),
  );
  await positionOverlay(overlay, monitor);
}

async function getCursorMonitor(): Promise<Monitor | null> {
  try {
    const cursor = await cursorPosition();
    const monitor = await monitorFromPoint(cursor.x, cursor.y);
    if (monitor) return monitor;

    const monitors = await availableMonitors();
    return monitors.find((m) => {
      const left = m.position.x;
      const top = m.position.y;
      const right = left + m.size.width;
      const bottom = top + m.size.height;
      return cursor.x >= left && cursor.x < right && cursor.y >= top && cursor.y < bottom;
    }) ?? null;
  } catch {
    return null;
  }
}

async function positionOverlay(overlay: Window, preferredMonitor: Monitor | null) {
  let monitor = preferredMonitor;
  if (!monitor) monitor = await currentMonitor();
  if (!monitor) return;
  const overlaySize = await overlay.outerSize();
  const pos = loadOverlayPosition();
  const margin = 96;
  const mx = monitor.position.x;
  const my = monitor.position.y;
  const mw = monitor.size.width;
  const mh = monitor.size.height;
  const ow = overlaySize.width;
  const oh = overlaySize.height;
  const centerX = mx + Math.floor((mw - ow) / 2);
  const rightX = mx + mw - ow - margin;
  const leftX = mx + margin;
  const topY = my + margin;
  const bottomY = my + mh - oh - margin;
  let x = centerX;
  let y = bottomY;
  switch (pos) {
    case "top-center":     x = centerX; y = topY;    break;
    case "bottom-center":  x = centerX; y = bottomY; break;
    case "top-right":      x = rightX;  y = topY;    break;
    case "bottom-right":   x = rightX;  y = bottomY; break;
    case "top-left":       x = leftX;   y = topY;    break;
    case "bottom-left":    x = leftX;   y = bottomY; break;
  }
  await overlay.setPosition(new PhysicalPosition(x, y));
}
