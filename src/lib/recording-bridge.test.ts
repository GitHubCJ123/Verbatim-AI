import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the tauri IPC surface so we can assert on the cancel-shortcut
// arm/disarm calls the recording bridge makes. `vi.hoisted` keeps these
// available inside the hoisted `vi.mock` factories below.
const { invoke, emit, listeners, ackConfig } = vi.hoisted(() => {
  const listeners = new Map<string, (e: unknown) => void>();
  const ackConfig = {
    mode: "listening" as "listening" | "error" | "none",
    drops: 0,
  };
  return {
    listeners,
    ackConfig,
    invoke: vi.fn(() => Promise.resolve()),
    // startRecording now waits for the overlay to ack `recording:listening`
    // for the session it emitted. Simulate the overlay's response as soon as
    // the bridge emits `recording:start`, honoring `ackConfig` so tests can
    // exercise the error and retry paths.
    emit: vi.fn((event: string, payload?: { sessionId?: number }) => {
      if (event === "recording:start") {
        if (ackConfig.drops > 0) {
          ackConfig.drops -= 1; // simulate a dropped/throttled event
          return Promise.resolve();
        }
        const sessionId = payload?.sessionId;
        if (ackConfig.mode === "listening") {
          listeners.get("recording:listening")?.({ payload: { sessionId } });
        } else if (ackConfig.mode === "error") {
          listeners
            .get("recording:error")
            ?.({ payload: { sessionId, message: "mic denied" } });
        }
      }
      return Promise.resolve();
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  invoke,
  emit,
  listen: (event: string, cb: (e: unknown) => void) => {
    listeners.set(event, cb);
    return Promise.resolve(() => {});
  },
}));

const fakeOverlay = vi.hoisted(() => ({
  setSize: vi.fn(() => Promise.resolve()),
  setPosition: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  outerSize: vi.fn(() => Promise.resolve({ width: 420, height: 96 })),
}));
const fakeMonitor = vi.hoisted(() => ({
  position: { x: 0, y: 0 },
  size: { width: 1000, height: 800 },
}));

vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: () => fakeOverlay },
  availableMonitors: () => Promise.resolve([fakeMonitor]),
  currentMonitor: () => Promise.resolve(fakeMonitor),
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
  monitorFromPoint: () => Promise.resolve(fakeMonitor),
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  PhysicalSize: class {
    constructor(public width: number, public height: number) {}
  },
}));
vi.mock("./preferences", () => ({ loadOverlayPosition: () => "bottom-center" }));

import { cancelRecording, startRecording, stopRecording } from "./recording-bridge";

describe("recording bridge cancel-shortcut lifecycle", () => {
  beforeEach(() => {
    invoke.mockClear();
    emit.mockClear();
    ackConfig.mode = "listening";
    ackConfig.drops = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("arms the global cancel shortcut when recording starts", async () => {
    await startRecording("Default", null, Date.now());
    expect(invoke).toHaveBeenCalledWith("enable_cancel_shortcut");
    expect(emit).toHaveBeenCalledWith(
      "recording:start",
      expect.objectContaining({ modeName: "Default" }),
    );
  });

  it("rejects and disarms when the overlay reports the mic failed to open", async () => {
    ackConfig.mode = "error";
    await expect(startRecording("Default", null, Date.now())).rejects.toThrow(
      /mic denied/,
    );
    // Failure must disarm Esc-to-cancel so it never lingers.
    expect(invoke).toHaveBeenCalledWith("disable_cancel_shortcut");
  });

  it("retries recording:start until the overlay acks", async () => {
    ackConfig.drops = 2; // drop the first two emits, then ack
    await startRecording("Default", null, Date.now());
    const startEmits = emit.mock.calls.filter((c) => c[0] === "recording:start");
    expect(startEmits.length).toBeGreaterThanOrEqual(3);
  });

  it("disarms the cancel shortcut when recording stops", async () => {
    await stopRecording();
    expect(invoke).toHaveBeenCalledWith("disable_cancel_shortcut");
    expect(emit).toHaveBeenCalledWith("recording:stop", {});
  });

  it("disarms the cancel shortcut when recording is cancelled", async () => {
    await cancelRecording();
    expect(invoke).toHaveBeenCalledWith("disable_cancel_shortcut");
    expect(emit).toHaveBeenCalledWith("recording:cancel", {});
  });
});
