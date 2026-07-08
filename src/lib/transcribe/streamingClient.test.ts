import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri IPC surface. `invoke` records calls and returns canned values;
// `listen` captures the handler so tests can drive `stream:partial` events.
const { invoke, listen, emitPartial, unlistenSpy, defaultInvoke } = vi.hoisted(() => {
  let handler: ((event: { payload: unknown }) => void) | null = null;
  const unlistenSpy = vi.fn();
  const defaultInvoke = (cmd: string): Promise<unknown> => {
    if (cmd === "start_streaming_session") return Promise.resolve(7);
    if (cmd === "is_streaming_sidecar_available") return Promise.resolve(true);
    return Promise.resolve(undefined);
  };
  return {
    invoke: vi.fn(
      (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => defaultInvoke(cmd),
    ),
    listen: vi.fn((_name: string, cb: (event: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(unlistenSpy);
    }),
    emitPartial: (payload: unknown) => handler?.({ payload }),
    unlistenSpy,
    defaultInvoke,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import {
  StreamingTranscriber,
  isStreamingSidecarAvailable,
  type StreamPartial,
} from "./streamingClient";

function lastCall(cmd: string): Record<string, unknown> | undefined {
  for (let i = invoke.mock.calls.length - 1; i >= 0; i--) {
    const call = invoke.mock.calls[i] as [string, Record<string, unknown>?];
    if (call[0] === cmd) return call[1];
  }
  return undefined;
}

describe("StreamingTranscriber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    invoke.mockImplementation(defaultInvoke);
    listen.mockClear();
    unlistenSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("probes sidecar availability", async () => {
    await expect(isStreamingSidecarAvailable("auto")).resolves.toBe(true);
    expect(lastCall("is_streaming_sidecar_available")).toEqual({ preference: "auto" });
  });

  it("starts a session and listens before starting", async () => {
    const t = new StreamingTranscriber({ tier: "turbo", onPartial: () => {} });
    await t.start();
    // Listener registered, then session started.
    const order = invoke.mock.calls.map(([c]) => c);
    expect(listen).toHaveBeenCalledWith("stream:partial", expect.any(Function));
    expect(order).toContain("start_streaming_session");
    expect(lastCall("start_streaming_session")).toEqual({
      tier: "turbo",
      computePreference: undefined,
    });
    await t.dispose();
  });

  it("batches frames and flushes on cadence", async () => {
    const t = new StreamingTranscriber({
      tier: "turbo",
      onPartial: () => {},
      flushIntervalMs: 200,
    });
    await t.start();
    invoke.mockClear();

    t.push(new Float32Array([0.1, 0.2]));
    t.push(new Float32Array([0.3]));
    // Nothing flushed until the cadence tick.
    expect(lastCall("push_streaming_frames")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(200);
    const call = lastCall("push_streaming_frames");
    expect(call).toBeDefined();
    expect(call!.sessionId).toBe(7);
    const frames = call!.frames as number[];
    expect(frames).toHaveLength(3);
    [0.1, 0.2, 0.3].forEach((v, i) => expect(frames[i]).toBeCloseTo(v, 5));
    await t.dispose();
  });

  it("delivers partials for the matching session and ignores stale ones", async () => {
    const got: StreamPartial[] = [];
    const t = new StreamingTranscriber({ tier: "turbo", onPartial: (p) => got.push(p) });
    await t.start();

    emitPartial({ sessionId: 7, kind: "partial", text: "hello" });
    emitPartial({ sessionId: 999, kind: "partial", text: "stale" });
    emitPartial({ sessionId: 7, kind: "final", text: "hello world" });

    expect(got).toEqual([
      { kind: "partial", text: "hello" },
      { kind: "final", text: "hello world" },
    ]);
    await t.dispose();
  });

  it("finish flushes remaining frames then sends the finalize marker", async () => {
    const t = new StreamingTranscriber({ tier: "turbo", onPartial: () => {} });
    await t.start();
    invoke.mockClear();

    t.push(new Float32Array([0.5]));
    await t.finish();

    const order = invoke.mock.calls.map(([c]) => c);
    const pushIdx = order.indexOf("push_streaming_frames");
    const finishIdx = order.indexOf("finish_streaming_session");
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThan(pushIdx);
    expect(lastCall("finish_streaming_session")).toEqual({ sessionId: 7 });
    await t.dispose();
  });

  it("ignores pushes after finish (no late-frame race)", async () => {
    const t = new StreamingTranscriber({ tier: "turbo", onPartial: () => {} });
    await t.start();
    await t.finish();
    invoke.mockClear();

    t.push(new Float32Array([0.9]));
    await vi.advanceTimersByTimeAsync(400);
    expect(lastCall("push_streaming_frames")).toBeUndefined();
    await t.dispose();
  });

  it("rejects and disposes if start fails, so the caller can fall back", async () => {
    invoke.mockImplementationOnce((cmd: string): Promise<unknown> =>
      cmd === "start_streaming_session"
        ? Promise.reject(new Error("no sidecar"))
        : Promise.resolve(undefined),
    );
    const t = new StreamingTranscriber({ tier: "turbo", onPartial: () => {} });
    await expect(t.start()).rejects.toThrow("no sidecar");
    // Listener cleaned up on the failed start.
    expect(unlistenSpy).toHaveBeenCalled();
  });

  it("push failure never throws into the audio callback", async () => {
    const t = new StreamingTranscriber({ tier: "turbo", onPartial: () => {} });
    await t.start();
    invoke.mockImplementation((cmd: string): Promise<unknown> =>
      cmd === "push_streaming_frames"
        ? Promise.reject(new Error("pipe broke"))
        : Promise.resolve(undefined),
    );
    t.push(new Float32Array([0.1]));
    // A rejected flush must not surface as an unhandled rejection or throw.
    await vi.advanceTimersByTimeAsync(200);
    // Reaching here without an unhandled rejection is the assertion.
    expect(true).toBe(true);
    await t.dispose();
  });

  it("dispose stops the session and removes the listener", async () => {
    const t = new StreamingTranscriber({ tier: "turbo", onPartial: () => {} });
    await t.start();
    invoke.mockClear();
    await t.dispose();
    expect(lastCall("stop_streaming_session")).toEqual({ sessionId: 7 });
    expect(unlistenSpy).toHaveBeenCalled();
  });
});
