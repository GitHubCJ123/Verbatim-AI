import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the tauri IPC surface so we can assert on the cancel-shortcut
// arm/disarm calls the recording bridge makes. `vi.hoisted` keeps these
// available inside the hoisted `vi.mock` factories below.
const { invoke, emit } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  emit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  invoke,
  emit,
  // The module attaches an `overlay:ready` listener at import time and
  // gates startRecording on it — fire the callback immediately so the
  // ready gate resolves without the 3s fallback timeout.
  listen: (event: string, cb: () => void) => {
    if (event === "overlay:ready") cb();
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
