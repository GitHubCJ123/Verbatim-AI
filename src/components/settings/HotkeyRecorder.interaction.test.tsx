// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  apply: vi.fn<(spec: string) => Promise<void>>(),
  current: vi.fn<() => Promise<string | null>>(),
  clear: vi.fn<() => Promise<void>>(),
  error: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../lib/preferences", () => ({ setHotkeyPaused: vi.fn() }));
vi.mock("../ui/Toast", () => ({ toast: { error: h.error } }));
vi.mock("../../lib/hotkey", () => ({
  applyHotkey: h.apply,
  getRegisteredHotkey: h.current,
  clearHotkey: h.clear,
  hotkeyErrorTitle: () => "Shortcut already in use",
  reservedHotkeyWarning: () => null,
  hotkeyDisplayParts: (spec: string) => spec.split("+"),
  isFunctionKey: (key: string) => /^F\d+$/.test(key),
  needsInputMonitoring: () => false,
  HOTKEY_PRESETS: [{ spec: "Fn" }, { spec: "F9" }],
  IS_MAC: true,
}));

import { HotkeyRecorder } from "./HotkeyRecorder";

describe("hotkey selection acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn((spec: string) => localStorage.setItem("sw.hotkey.spec", spec));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    localStorage.setItem("sw.hotkey.spec", "F6");
    h.apply.mockReset().mockResolvedValue(undefined);
    h.current.mockReset().mockResolvedValue("F6");
    h.clear.mockReset().mockResolvedValue(undefined);
    h.invoke.mockReset().mockResolvedValue(undefined);
    h.error.mockReset();
    onChange.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(value = "F6") {
    await act(async () => root.render(<HotkeyRecorder value={value} onChange={onChange} />));
  }

  async function preset(spec: string) {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === spec);
    expect(button).toBeDefined();
    await act(async () => button!.click());
    return button!;
  }

  it("does not display or save a rejected quick pick", async () => {
    h.apply.mockRejectedValueOnce("hotkey-in-use: choose another shortcut");
    await render();
    const button = await preset("F9");
    expect(h.apply).toHaveBeenCalledWith("F9");
    expect(onChange).not.toHaveBeenCalled();
    expect(localStorage.getItem("sw.hotkey.spec")).toBe("F6");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[aria-label="Record shortcut"]')?.textContent).toBe("F6");
    expect(h.error).toHaveBeenCalledWith("Shortcut already in use", expect.anything());
  });

  it("publishes a quick pick only after registration succeeds", async () => {
    let resolve!: () => void;
    h.apply.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    await render();
    const button = await preset("F9");
    expect(button.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(localStorage.getItem("sw.hotkey.spec")).toBe("F6");
    await act(async () => resolve());
    expect(onChange).toHaveBeenCalledWith("F9", true);
    expect(localStorage.getItem("sw.hotkey.spec")).toBe("F9");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps a modifier preset explicitly pending when Input Monitoring is missing", async () => {
    h.apply.mockRejectedValueOnce("needs-input-monitoring");
    await render();
    await preset("Fn");
    expect(onChange).toHaveBeenCalledWith("Fn", false);
    expect(h.error).toHaveBeenCalledWith("Input Monitoring permission needed", expect.anything());
  });

  it.each(["", "Control+Shift+K"])("restores the actual binding, not the mode draft %s", async (draft) => {
    h.apply.mockRejectedValueOnce("hotkey-in-use: choose another shortcut");
    await render(draft);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Record shortcut"]')!.click();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F9", code: "F9", bubbles: true }));
    });
    expect(h.current).toHaveBeenCalledOnce();
    expect(h.clear).toHaveBeenCalledOnce();
    expect(h.apply.mock.calls).toEqual([["F9"], ["F6"]]);
    expect(onChange).not.toHaveBeenCalled();
    expect(localStorage.getItem("sw.hotkey.spec")).toBe("F6");
  });
});
