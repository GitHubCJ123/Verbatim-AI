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
  // Capture registered listeners by event name so tests can drive events.
  listen: vi.fn((_event?: string, _cb?: (e: unknown) => void) => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
// Avoid pulling the tauri autostart plugin (and localStorage) via preferences.
vi.mock("./preferences", () => ({ isPerfDebugEnabled: () => false }));

import { decodeFrame, startNativeRecording } from "./nativeAudio";
import { VAD_FRAME_SAMPLES } from "./vad/vad";

/** Base64-encode a Float32Array as little-endian bytes (mirrors Rust). */
function encodeFrame(frame: Float32Array): string {
  const bytes = new Uint8Array(frame.length * 4);
  const view = new DataView(bytes.buffer);
  frame.forEach((s, i) => view.setFloat32(i * 4, s, true));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe("nativeAudio capture controller", () => {
  beforeEach(() => {
    invoke.mockClear();
    listen.mockClear();
    // Restore the default no-op listener; individual tests may override it.
    listen.mockImplementation((_event?: string, _cb?: (e: unknown) => void) =>
      Promise.resolve(() => {}),
    );
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
    expect(invoke).toHaveBeenCalledWith("start_native_capture", {
      deviceName: "USB Mic",
      streamFrames: false,
    });
  });

  it("passes null device name when no device is selected", async () => {
    await startNativeRecording({});
    expect(invoke).toHaveBeenCalledWith("start_native_capture", {
      deviceName: null,
      streamFrames: false,
    });
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

  it("getFrameCount is 0 when no onFrame sink is provided (streaming inert)", async () => {
    const controller = await startNativeRecording({});
    expect(controller.getFrameCount()).toBe(0);
    // No frame listener registered without a sink.
    expect(listen).not.toHaveBeenCalledWith("native_audio:frame", expect.any(Function));
  });

  it("opts into frame streaming and forwards decoded frames to onFrame", async () => {
    // Capture the registered frame handler so we can drive events.
    let frameHandler: ((event: { payload: { data: string } }) => void) | null = null;
    listen.mockImplementation((event?: string, cb?: (e: unknown) => void) => {
      if (event === "native_audio:frame") {
        frameHandler = cb as typeof frameHandler;
      }
      return Promise.resolve(() => {});
    });

    const frames: Float32Array[] = [];
    const controller = await startNativeRecording({ onFrame: (f) => frames.push(f) });

    // Rust is told to stream frames.
    expect(invoke).toHaveBeenCalledWith("start_native_capture", {
      deviceName: null,
      streamFrames: true,
    });
    expect(frameHandler).not.toBeNull();

    const sent = new Float32Array(VAD_FRAME_SAMPLES);
    for (let i = 0; i < sent.length; i++) sent[i] = Math.sin(i * 0.1) * 0.5;
    frameHandler!({ payload: { data: encodeFrame(sent) } });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(VAD_FRAME_SAMPLES);
    for (let i = 0; i < sent.length; i++) {
      expect(frames[0][i]).toBeCloseTo(sent[i], 5);
    }
    expect(controller.getFrameCount()).toBe(1);
  });

  it("drops malformed frames whose length is not a full VAD frame", async () => {
    let frameHandler: ((event: { payload: { data: string } }) => void) | null = null;
    listen.mockImplementation((event?: string, cb?: (e: unknown) => void) => {
      if (event === "native_audio:frame") frameHandler = cb as typeof frameHandler;
      return Promise.resolve(() => {});
    });

    const frames: Float32Array[] = [];
    const controller = await startNativeRecording({ onFrame: (f) => frames.push(f) });
    // A short (non-480) frame must be ignored before reaching the sink.
    frameHandler!({ payload: { data: encodeFrame(new Float32Array(100)) } });
    expect(frames).toHaveLength(0);
    expect(controller.getFrameCount()).toBe(0);
  });

  it("decodeFrame round-trips little-endian f32 bytes", () => {
    const original = new Float32Array([0, 1, -0.5, 0.25, 12345.678]);
    const decoded = decodeFrame(encodeFrame(original));
    expect(decoded).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 3);
    }
  });
});
