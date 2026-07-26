import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri IPC surface. `start_native_capture` resolves; `stop_native_capture`
// returns a canned PCM buffer we can assert gets wrapped into a WAV blob.
const { invoke, listen, defaultInvokeImpl } = vi.hoisted(() => {
  const defaultInvokeImpl = (cmd: string): Promise<unknown> => {
    if (cmd === "stop_native_capture") {
      // 16000 samples == 1s at 16 kHz.
      return Promise.resolve(Array.from({ length: 16000 }, () => 0.1));
    }
    return Promise.resolve();
  };
  return {
    defaultInvokeImpl,
    invoke: vi.fn(defaultInvokeImpl),
    // Capture registered listeners by event name so tests can drive events.
    listen: vi.fn((_event?: string, _cb?: (e: unknown) => void) => Promise.resolve(() => {})),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
// Avoid pulling the tauri autostart plugin (and localStorage) via preferences.
vi.mock("./preferences", () => ({ isPerfDebugEnabled: () => false }));

import { adoptNativeRecording, decodeFrame, startNativeRecording } from "./nativeAudio";
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
    // Restore the default implementations; individual tests may override them.
    invoke.mockImplementation(defaultInvokeImpl);
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

  // ── adoptNativeRecording (issue #53: Rust-first push-to-talk hot path) ──

  it("adopts an already-started session without arming or starting a new one", async () => {
    const controller = await adoptNativeRecording(42, { deviceId: "mic-1" });
    const calledCommands = invoke.mock.calls.map((c) => c[0]);
    // Adoption only ever re-arms (to fix up `streamFrames` after mode
    // resolution) — it must never start a second session on top of the one
    // Rust's hot path already started.
    expect(calledCommands).toContain("arm_native_capture");
    expect(calledCommands).not.toContain("start_native_session");
    expect(calledCommands).not.toContain("start_native_capture");
    expect(invoke).toHaveBeenCalledWith("arm_native_capture", {
      deviceName: "USB Mic",
      keepWarm: false,
      streamFrames: false,
    });
    expect(controller.getFrameCount()).toBe(0);
  });

  it("adopted session's stop() takes the given session id", async () => {
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "take_native_recording" && args?.sessionId === 42) {
        return Promise.resolve(Array.from({ length: 8000 }, () => 0.1));
      }
      return Promise.resolve();
    });
    const controller = await adoptNativeRecording(42, {});
    invoke.mockClear(); // mockClear only resets call history, not the implementation above
    const result = await controller.stop();
    expect(invoke).toHaveBeenCalledWith("stop_native_session", { sessionId: 42 });
    expect(invoke).toHaveBeenCalledWith("take_native_recording", { sessionId: 42 });
    expect(result).not.toBeNull();
    expect(Math.round(result!.durationMs)).toBe(500); // 8000 / 16000 Hz
  });

  it("adoption re-arm failure does not prevent the controller from being usable", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "arm_native_capture") return Promise.reject(new Error("device busy"));
      return Promise.resolve();
    });
    // Must not throw — the re-arm is best-effort; the session Rust already
    // started keeps recording either way.
    const controller = await adoptNativeRecording(7, {});
    expect(controller.getFrameCount()).toBe(0);
  });

  // ── native_audio:error (issue #53, S2) ──────────────────────────────

  it("surfaces a mid-session native_audio:error via onError and stops cleanly", async () => {
    let errorHandler: ((event: { payload: { sessionId?: number; message: string } }) => void) | null =
      null;
    listen.mockImplementation((event?: string, cb?: (e: unknown) => void) => {
      if (event === "native_audio:error") {
        errorHandler = cb as typeof errorHandler;
      }
      return Promise.resolve(() => {});
    });

    const onError = vi.fn();
    const controller = await startNativeRecording({ onError });
    invoke.mockClear();

    errorHandler!({ payload: { sessionId: 0, message: "The input device is no longer available." } });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      "The input device is no longer available.",
    );

    // stop() must be a safe no-op afterward — no second take/stop call, and
    // no result that could be mistaken for a successful recording.
    const result = await controller.stop();
    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
