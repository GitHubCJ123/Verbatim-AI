import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted handles so the module mocks below can be inspected and
// driven from the tests (deferred promises let us order down/up events
// against an in-flight async startup).
const h = vi.hoisted(() => ({
  listeners: new Map<string, (e: unknown) => void>(),
  startRecording: vi.fn(() => Promise.resolve()),
  stopRecording: vi.fn(() => Promise.resolve()),
  cancelRecording: vi.fn(() => Promise.resolve()),
  resolveModeAtPress: vi.fn(),
}));

// hotkey.ts pulls in the recording pipeline and tauri IPC at import
// time; stub the surface so we can exercise its helpers + state machine.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: unknown) => void) => {
    h.listeners.set(name, cb);
    return Promise.resolve(() => h.listeners.delete(name));
  }),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("./recording-bridge", () => ({
  startRecording: h.startRecording,
  stopRecording: h.stopRecording,
  cancelRecording: h.cancelRecording,
}));
vi.mock("./modeResolver", () => ({ resolveModeAtPress: h.resolveModeAtPress }));
vi.mock("./preferences", () => ({ isHotkeyPaused: vi.fn(() => false) }));
vi.mock("./store/useOnboarding", () => ({ isOnboardingComplete: vi.fn(() => true) }));
vi.mock("./nativeAudio", () => ({ syncNativeCaptureArm: vi.fn(() => Promise.resolve()) }));
vi.mock("./ai/localWhisper", () => ({
  ensureWhisperEngineReady: vi.fn(),
  getAiProviderKind: vi.fn(),
  getLocalWhisperEngine: vi.fn(),
  getLocalWhisperTier: vi.fn(),
}));

import {
  hotkeyDisplayParts,
  installHotkeyListeners,
  isForcedHoldSpec,
  isSingleKeySpec,
  usesHoldToTalk,
} from "./hotkey";

describe("hotkey spec helpers — modifier-only triggers", () => {
  it("treats the fn and Right ⌘ sentinels as single-key specs", () => {
    expect(isSingleKeySpec("Fn")).toBe(true);
    expect(isSingleKeySpec("RightCommand")).toBe(true);
    expect(isSingleKeySpec("Control+Shift+Space")).toBe(false);
  });

  it("renders the Right ⌘ sentinel as a single labelled part", () => {
    // The sentinel has no '+', so it must survive as one display token
    // (the exact glyph varies by platform label map).
    expect(hotkeyDisplayParts("RightCommand")).toHaveLength(1);
    expect(hotkeyDisplayParts("Control+Space")).toHaveLength(2);
  });

  it("forces hold-to-talk when push-to-talk is enabled, regardless of spec", () => {
    expect(usesHoldToTalk({ spec: "RightCommand", pushToTalk: true })).toBe(true);
    expect(usesHoldToTalk({ spec: "Control+Space", pushToTalk: true })).toBe(true);
  });

  it("does not force hold-to-talk for a multi-key toggle spec", () => {
    expect(usesHoldToTalk({ spec: "Control+Shift+Space", pushToTalk: false })).toBe(false);
  });

  it("forces hold only for bare fn / right ⌘, not function keys or combos", () => {
    expect(isForcedHoldSpec("Fn")).toBe(true);
    expect(isForcedHoldSpec("RightCommand")).toBe(true);
    expect(isForcedHoldSpec("F6")).toBe(false);
    expect(isForcedHoldSpec("Control+Shift+Space")).toBe(false);
    // A function key or combo respects the user's toggle choice.
    expect(usesHoldToTalk({ spec: "F6", pushToTalk: false })).toBe(false);
    expect(usesHoldToTalk({ spec: "Fn", pushToTalk: false })).toBe(true);
  });
});

// ─── Recording state machine (Bug A regression coverage) ─────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drain the microtask queue enough times for a multi-await async worker
// to run to completion. No real timers or IPC involved.
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const MODE = {
  mode: { name: "Default", id: "m1" },
  activeWindow: { exe: "app", exe_path: "", title: "" },
};

describe("installHotkeyListeners — serialized recording state machine", () => {
  let store: Map<string, string>;

  const setConfig = (spec: string, pushToTalk: boolean) => {
    store.set("sw.hotkey.spec", spec);
    store.set("sw.hotkey.ptt", pushToTalk ? "1" : "0");
  };

  const down = () => h.listeners.get("hotkey:down")!(undefined);
  const up = () => h.listeners.get("hotkey:up")!(undefined);

  beforeEach(() => {
    store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    });
    h.listeners.clear();
    h.startRecording.mockReset();
    h.stopRecording.mockReset();
    h.cancelRecording.mockReset();
    h.resolveModeAtPress.mockReset();
    h.startRecording.mockResolvedValue(undefined);
    h.stopRecording.mockResolvedValue(undefined);
    h.cancelRecording.mockResolvedValue(undefined);
    h.resolveModeAtPress.mockResolvedValue(MODE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HOLD: release before startup resolves still stops the recording (core race)", async () => {
    setConfig("Control+Shift+Space", true); // pushToTalk → hold
    const modeD = deferred<typeof MODE>();
    const startD = deferred<void>();
    h.resolveModeAtPress.mockReturnValue(modeD.promise);
    h.startRecording.mockReturnValue(startD.promise);

    await installHotkeyListeners();

    down();
    up(); // released while still 'starting' → must be honored
    await flush();
    expect(h.startRecording).not.toHaveBeenCalled();

    modeD.resolve(MODE);
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.stopRecording).not.toHaveBeenCalled();

    startD.resolve();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("HOLD: normal press then release starts once and stops once", async () => {
    setConfig("Control+Shift+Space", true);
    await installHotkeyListeners();

    down();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.stopRecording).not.toHaveBeenCalled();

    up();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("TOGGLE: tap starts, next tap stops (release is a no-op)", async () => {
    setConfig("Control+Shift+Space", false); // combo + ptt off → toggle
    await installHotkeyListeners();

    down();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);

    up(); // toggle: release must not stop
    await flush();
    expect(h.stopRecording).not.toHaveBeenCalled();

    down();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("NO-MODE: a mode-less press resets state so the next press can start", async () => {
    setConfig("Control+Shift+Space", true);
    h.resolveModeAtPress.mockResolvedValue({ mode: null, activeWindow: null });
    await installHotkeyListeners();

    down();
    await flush();
    expect(h.startRecording).not.toHaveBeenCalled();
    expect(h.resolveModeAtPress).toHaveBeenCalledTimes(1);

    // State must be idle again — a subsequent hold press re-enters startup.
    down();
    await flush();
    expect(h.resolveModeAtPress).toHaveBeenCalledTimes(2);
  });

  it("START-FAILURE: stops defensively and a later press can start again", async () => {
    setConfig("Control+Shift+Space", true);
    h.startRecording.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await installHotkeyListeners();

    down();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(h.stopRecording).toHaveBeenCalledTimes(1); // defensive stop

    down();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });

  it("CANCEL during startup does not resurrect recording state", async () => {
    setConfig("Control+Shift+Space", true); // hold
    const startD = deferred<void>();
    h.startRecording.mockReturnValue(startD.promise);
    await installHotkeyListeners();

    down(); // recState = 'starting'
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1); // now awaiting startup

    // Escape/cancel fires while startup is still in flight.
    h.listeners.get("hotkey:cancel")!(undefined);
    await flush();
    expect(h.cancelRecording).toHaveBeenCalledTimes(1);

    // Startup now resolves — must NOT strand the FSM in 'recording'.
    startD.resolve();
    await flush();

    // Proof the machine is idle again: a fresh hold press starts anew.
    down();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(2);
  });

  it("stopping uses the active session's kind, not current config (toggle then PTT on)", async () => {
    setConfig("Control+Shift+Space", false); // combo + ptt off → toggle
    await installHotkeyListeners();

    down(); // start a toggle session
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1);

    // User flips push-to-talk ON while the toggle recording is still active.
    setConfig("Control+Shift+Space", true); // usesHoldToTalk() now true

    down(); // must stop the active TOGGLE session, not be ignored as a hold press
    await flush();
    expect(h.stopRecording).toHaveBeenCalledTimes(1);

    // FSM is idle again — a fresh (now hold) press starts once more.
    down();
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(2);
  });

  it("TOGGLE: rapid on/off/on during startup converges to recording", async () => {
    setConfig("Control+Shift+Space", false); // toggle
    const startD = deferred<void>();
    h.startRecording.mockReturnValue(startD.promise);
    await installHotkeyListeners();

    down(); // on → starting
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(1); // awaiting startup
    down(); // off (net intent: stop)
    down(); // on  (net intent: record)
    startD.resolve();
    await flush();
    expect(h.stopRecording).not.toHaveBeenCalled(); // converged to ON

    down(); // now toggle it off
    await flush();
    expect(h.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("a superseded startup does not prematurely flip the live session to 'recording'", async () => {
    setConfig("Control+Shift+Space", false); // toggle
    const start1 = deferred<void>();
    const start2 = deferred<void>();
    h.startRecording.mockReturnValueOnce(start1.promise).mockReturnValueOnce(start2.promise);
    await installHotkeyListeners();

    down(); // attempt #1
    await flush();
    h.listeners.get("hotkey:cancel")!(undefined); // cancel invalidates #1
    await flush();
    down(); // attempt #2 — still 'starting', start2 pending
    await flush();
    expect(h.startRecording).toHaveBeenCalledTimes(2);

    start1.resolve(); // stale #1 resolves — must be a no-op (not set 'recording')
    await flush();

    // If #1 had flipped state to 'recording', this toggle tap would stop
    // immediately even though #2 has not finished starting.
    down();
    await flush();
    expect(h.stopRecording).not.toHaveBeenCalled();

    // #2 finishes; the pending toggle-off now applies exactly once.
    start2.resolve();
    await flush();
    expect(h.stopRecording).toHaveBeenCalledTimes(1);
  });
});
