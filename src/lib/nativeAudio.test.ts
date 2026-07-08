import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri IPC surface. `start_native_capture` resolves; `stop_native_capture`
// returns a canned PCM buffer we can assert gets wrapped into a WAV blob.
const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "stop_native_capture") {
      // 16000 samples == 1s at 16 kHz.
      return Promise.resolve(Array.from({ length: 16000 }, () => 0.1));
    }
    return Promise.resolve();
  }),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
// Avoid pulling the tauri autostart plugin (and localStorage) via preferences.
vi.mock("./preferences", () => ({ isPerfDebugEnabled: () => false }));

import { startNativeRecording } from "./nativeAudio";

describe("nativeAudio capture controller", () => {
  beforeEach(() => {
    invoke.mockClear();
    listen.mockClear();
    // enumerateDevices used to resolve the device label.
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: () =>
          Promise.resolve([{ kind: "audioinput", deviceId: "mic-1", label: "USB Mic" }]),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("starts native capture and passes the resolved device label", async () => {
    const onStart = vi.fn();
    await startNativeRecording({ deviceId: "mic-1", onStart });
    expect(onStart).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("start_native_capture", { deviceName: "USB Mic" });
  });

  it("passes null device name when no device is selected", async () => {
    await startNativeRecording({});
    expect(invoke).toHaveBeenCalledWith("start_native_capture", { deviceName: null });
  });

  it("stop returns a 16 kHz WAV blob with a duration derived from PCM length", async () => {
    const controller = await startNativeRecording({});
    const result = await controller.stop();
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("audio/wav");
    expect(result!.blob.type).toBe("audio/wav");
    // 16000 samples / 16 kHz == 1000 ms.
    expect(Math.round(result!.durationMs)).toBe(1000);
    // WAV header (44 bytes) + 16000 * 2 bytes of PCM16.
    expect(result!.blob.size).toBe(44 + 16000 * 2);
    expect(invoke).toHaveBeenCalledWith("stop_native_capture");
  });

  it("stop is idempotent — a second call returns null without re-invoking", async () => {
    const controller = await startNativeRecording({});
    await controller.stop();
    invoke.mockClear();
    const second = await controller.stop();
    expect(second).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("stop_native_capture");
  });

  it("cancel stops the native stream and discards audio", async () => {
    const controller = await startNativeRecording({});
    invoke.mockClear();
    controller.cancel();
    expect(invoke).toHaveBeenCalledWith("stop_native_capture");
  });

  it("getFrameCount is 0 (native frame streaming deferred)", async () => {
    const controller = await startNativeRecording({});
    expect(controller.getFrameCount()).toBe(0);
  });
});
