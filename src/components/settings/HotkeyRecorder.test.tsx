import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn<(command: string) => Promise<unknown>>(),
  listen: vi.fn(),
  applyHotkey: vi.fn<(spec: string) => Promise<void>>(),
  clearHotkey: vi.fn<() => Promise<void>>(),
  setHotkeyPaused: vi.fn(),
  listeners: new Map<string, () => void>(),
  keydown: null as ((event: KeyboardEvent) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: h.listen,
}));
vi.mock("../../lib/hotkey", () => ({
  applyHotkey: h.applyHotkey,
  clearHotkey: h.clearHotkey,
  isFunctionKey: (key: string) => /^F([1-9]|1[0-9]|2[0-4])$/.test(key),
  IS_MAC: true,
}));
vi.mock("../../lib/preferences", () => ({
  setHotkeyPaused: h.setHotkeyPaused,
}));
vi.mock("../ui/Toast", () => ({
  toast: { error: vi.fn() },
}));

import {
  HotkeyCaptureSession,
  HotkeyRecorder,
} from "./HotkeyRecorder";

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function keyEvent(
  key: string,
  options: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key,
    code: options.code ?? key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...options,
  } as KeyboardEvent;
}

function createSession() {
  const callbacks = {
    onRecordingChange: vi.fn(),
    onBusyChange: vi.fn(),
    onPendingModifiersChange: vi.fn(),
    onReset: vi.fn(),
    onCommit: vi.fn(),
    onFnCaptureUnavailable: vi.fn(),
    onUnsupportedKey: vi.fn(),
    onError: vi.fn(),
  };
  return { session: new HotkeyCaptureSession(callbacks), callbacks };
}

function fireKey(event: KeyboardEvent): void {
  expect(h.keydown).not.toBeNull();
  h.keydown!(event);
}

describe("HotkeyRecorder capture transaction", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(
        (name: string, callback: (event: KeyboardEvent) => void) => {
          if (name === "keydown") h.keydown = callback;
        },
      ),
      removeEventListener: vi.fn(
        (name: string, callback: (event: KeyboardEvent) => void) => {
          if (name === "keydown" && h.keydown === callback) h.keydown = null;
        },
      ),
    });

    h.listeners.clear();
    h.keydown = null;
    h.invoke.mockReset();
    h.listen.mockReset();
    h.applyHotkey.mockReset();
    h.clearHotkey.mockReset();
    h.setHotkeyPaused.mockReset();
    h.invoke.mockResolvedValue(undefined);
    h.applyHotkey.mockResolvedValue(undefined);
    h.clearHotkey.mockResolvedValue(undefined);
    h.listen.mockImplementation(
      async (name: string, callback: () => void) => {
        h.listeners.set(name, callback);
        return () => h.listeners.delete(name);
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "a modifier combination",
      keyEvent("k", { code: "KeyK", ctrlKey: true, shiftKey: true }),
      "Control+Shift+K",
    ],
    ["a function key", keyEvent("F6"), "F6"],
  ])("commits %s", async (_name, event, expectedSpec) => {
    const { session, callbacks } = createSession();
    await session.start("Control+Space");

    fireKey(event);
    await flush();

    expect(h.applyHotkey).toHaveBeenCalledTimes(1);
    expect(h.applyHotkey).toHaveBeenCalledWith(expectedSpec);
    expect(callbacks.onCommit).toHaveBeenCalledWith(expectedSpec);
    expect(h.invoke).toHaveBeenCalledWith("stop_hotkey_capture");
  });

  it("rejects a bare alphanumeric key (would hijack typing globally)", async () => {
    const { session, callbacks } = createSession();
    await session.start("Control+Space");

    fireKey(keyEvent("a", { code: "KeyA" }));
    await flush();

    // No commit: recorder stays open and the previous shortcut is untouched.
    expect(callbacks.onCommit).not.toHaveBeenCalled();
    expect(h.applyHotkey).not.toHaveBeenCalled();
  });

  it("Escape restores the previous spec and stops native capture", async () => {
    const { session, callbacks } = createSession();
    await session.start("Control+Shift+Space");

    fireKey(keyEvent("Escape"));
    await flush();

    expect(h.applyHotkey).toHaveBeenCalledWith("Control+Shift+Space");
    expect(callbacks.onCommit).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith("stop_hotkey_capture");
    expect(h.setHotkeyPaused).toHaveBeenLastCalledWith(false);
  });

  it("Cancel restores the previous spec and stops native capture", async () => {
    const { session, callbacks } = createSession();
    await session.start("Alt+Space");

    await session.cleanup();

    expect(h.applyHotkey).toHaveBeenCalledTimes(1);
    expect(h.applyHotkey).toHaveBeenCalledWith("Alt+Space");
    expect(callbacks.onCommit).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith("stop_hotkey_capture");
  });

  it("applies only the new spec after a successful commit", async () => {
    const { session } = createSession();
    await session.start("Control+Space");

    fireKey(keyEvent("F6"));
    await flush();

    expect(h.applyHotkey.mock.calls).toEqual([["F6"]]);
  });

  it("continues WebView capture when native fn capture lacks permission", async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === "start_hotkey_capture") {
        throw new Error("needs-input-monitoring");
      }
    });
    const { session, callbacks } = createSession();

    await expect(session.start("Control+Space")).resolves.toBeUndefined();
    expect(callbacks.onFnCaptureUnavailable).toHaveBeenCalledOnce();

    fireKey(keyEvent("F6"));
    await flush();
    expect(h.applyHotkey).toHaveBeenCalledWith("F6");
  });

  it("aborts capture and restores the previous spec when clear fails", async () => {
    h.clearHotkey.mockRejectedValueOnce(new Error("clear failed"));
    const { session, callbacks } = createSession();

    await session.start("Control+Space");

    expect(h.keydown).toBeNull();
    expect(h.setHotkeyPaused).not.toHaveBeenCalledWith(true);
    expect(h.applyHotkey).toHaveBeenCalledWith("Control+Space");
    expect(callbacks.onCommit).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith("clear failed");
  });

  it("lets F6 win over fn when a WebView keydown intervenes", async () => {
    const { session, callbacks } = createSession();
    await session.start("Control+Space");

    h.listeners.get("hotkey-capture:fn-down")!();
    fireKey(keyEvent("F6"));
    h.listeners.get("hotkey-capture:fn-up")!();
    await flush();

    expect(h.applyHotkey.mock.calls).toEqual([["F6"]]);
    expect(callbacks.onCommit).toHaveBeenCalledWith("F6");
    expect(callbacks.onCommit).not.toHaveBeenCalledWith("Fn");
  });

  it("commits bare fn only when fn-up has no intervening keydown", async () => {
    const { session, callbacks } = createSession();
    await session.start("Control+Space");

    h.listeners.get("hotkey-capture:fn-down")!();
    h.listeners.get("hotkey-capture:fn-up")!();
    await flush();

    expect(h.applyHotkey.mock.calls).toEqual([["Fn"]]);
    expect(callbacks.onCommit).toHaveBeenCalledWith("Fn");
  });

  it("ignores a late fn-up after cancel", async () => {
    const { session, callbacks } = createSession();
    await session.start("Control+Space");
    const lateFnUp = h.listeners.get("hotkey-capture:fn-up")!;

    h.listeners.get("hotkey-capture:fn-down")!();
    await session.cleanup();
    lateFnUp();
    await flush();

    expect(h.applyHotkey.mock.calls).toEqual([["Control+Space"]]);
    expect(callbacks.onCommit).not.toHaveBeenCalled();
  });

  it("renders a legacy RightCommand value as right ⌘", () => {
    const html = renderToStaticMarkup(
      <HotkeyRecorder value="RightCommand" onChange={vi.fn()} />,
    );

    expect(html).toContain("right ⌘");
  });
});
