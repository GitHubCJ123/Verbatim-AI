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

// The global Escape "cancel-during-recording" shortcut is armed only
// while a dictation is in flight, so Escape reaches the foreground app
// normally the rest of the time. Arm on start, disarm on every terminal
// path (stop, cancel, start failure) so it never lingers.
async function armCancelShortcut(): Promise<void> {
  try {
    await invoke("enable_cancel_shortcut");
  } catch {
    /* non-fatal: recording still works, just no Esc-to-cancel */
  }
}

async function disarmCancelShortcut(): Promise<void> {
  try {
    await invoke("disable_cancel_shortcut");
  } catch {
    /* ignore */
  }
}

const OVERLAY_PILL_SIZE = { width: 420, height: 96 };
const OVERLAY_REVIEW_SIZE = { width: 520, height: 360 };

// Tauri cross-window events are fire-and-forget: if the overlay's listener
// isn't live yet (or its hidden webview is throttled by macOS App Nap) when
// `recording:start` is emitted, the event is silently dropped and the mic
// never opens. To make start reliable we use a per-session handshake — the
// bridge re-emits `recording:start` until the overlay acks with
// `recording:listening` (mic open) or `recording:error`, and only then does
// the caller's promise resolve. A missed event is simply retried; a real
// failure rejects, so the hotkey state machine resets instead of believing it
// is recording when it isn't.
let sessionCounter = 0;

const START_RETRY_INTERVAL_MS = 200;
const START_ACK_TIMEOUT_MS = 4000;

interface SessionAck {
  promise: Promise<void>;
  cancel: () => void;
}

// Subscribe to the ack events for `sessionId` BEFORE the first emit so a fast
// ack can never be missed. Resolves on `recording:listening`, rejects on
// `recording:error` or after `START_ACK_TIMEOUT_MS`.
async function listenForSessionAck(sessionId: number): Promise<SessionAck> {
  let settle: (() => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const [offListening, offError] = await Promise.all([
    listen<{ sessionId?: number }>("recording:listening", (e) => {
      if ((e.payload?.sessionId ?? 0) === sessionId) settle?.();
    }),
    listen<{ sessionId?: number; message?: string }>("recording:error", (e) => {
      if ((e.payload?.sessionId ?? 0) === sessionId) {
        fail?.(new Error(e.payload?.message || "recording failed to start"));
      }
    }),
  ]);
  const timer = setTimeout(() => {
    fail?.(new Error("overlay did not confirm the microphone opened"));
  }, START_ACK_TIMEOUT_MS);
  const cancel = () => {
    clearTimeout(timer);
    offListening();
    offError();
  };
  return { promise, cancel };
}

async function getOverlay(): Promise<Window | null> {
  try {
    const w = Window.getByLabel(OVERLAY_LABEL);
    return (await Promise.resolve(w)) ?? null;
  } catch {
    return null;
  }
}

export async function startRecording(
  modeName = "Default",
  modeId: string | null = null,
  pressedAt: number = Date.now(),
): Promise<void> {
  const overlay = await getOverlay();
  if (!overlay) throw new Error("overlay window unavailable");

  const sessionId = ++sessionCounter;

  // Subscribe to the overlay's ack first so we never miss it.
  const ack = await listenForSessionAck(sessionId);

  // Arm Esc-to-cancel the moment capture begins (disarmed on every
  // terminal path below).
  void armCancelShortcut();

  // Emit immediately — the overlay opens the mic ASAP (latency is the
  // product) — and re-emit on an interval until the overlay acks, so a
  // dropped or throttled event can't strand the recording.
  const emitStart = () =>
    void emit("recording:start", { modeName, modeId, pressedAt, sessionId });
  emitStart();
  const retry = setInterval(emitStart, START_RETRY_INTERVAL_MS);

  // Window chrome runs concurrently. Showing the overlay also wakes its
  // (possibly App-Nap-throttled) webview so it can receive the event.
  // Capture the foreground window *before* showing the overlay so we can
  // paste back into it (plan §14).
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
    try {
      await overlay.show();
    } catch {
      /* best-effort */
    }
  })();

  try {
    // Resolves only when the overlay confirms the mic is open; rejects on
    // overlay error or timeout so the caller (hotkey FSM) can reset.
    await ack.promise;
  } catch (e) {
    clearInterval(retry);
    ack.cancel();
    void disarmCancelShortcut();
    throw e;
  }
  clearInterval(retry);
  ack.cancel();
  await chrome.catch(() => {});
}

export async function stopRecording() {
  await disarmCancelShortcut();
  await emit("recording:stop", {});
}

export async function cancelRecording() {
  await disarmCancelShortcut();
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
