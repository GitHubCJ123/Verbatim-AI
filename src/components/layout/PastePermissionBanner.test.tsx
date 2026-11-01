// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mac: true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../../lib/os", () => ({ isMac: () => h.mac }));
import { PastePermissionBanner } from "./PastePermissionBanner";

let container: HTMLDivElement;
let root: Root;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function render() {
  await act(async () => {
    root.render(<PastePermissionBanner />);
    await flush();
  });
}

describe("automatic typing permission detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    h.mac = true;
    h.invoke.mockReset().mockResolvedValue(false);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("detects missing access on launch and explains setup without a paste attempt", async () => {
    await render();
    expect(h.invoke).toHaveBeenCalledWith("check_accessibility_permission");
    expect(h.invoke).not.toHaveBeenCalledWith("request_accessibility_permission");
    expect(container.textContent).toContain("Device Control and Data Access");
    expect(container.textContent).toContain("Accessibility on older macOS versions");
    expect(container.textContent).toContain("If already enabled after an update");
    await act(async () => {
      container.querySelector("button")!.click();
      await flush();
    });
    expect(h.invoke.mock.calls.map(([name]) => name)).toEqual([
      "check_accessibility_permission",
      "request_accessibility_permission",
      "open_accessibility_settings",
    ]);
  });

  it("detects revoked permission on focus and removes guidance when access returns", async () => {
    h.invoke.mockResolvedValue(true);
    await render();
    expect(container.textContent).toBe("");
    h.invoke.mockResolvedValue(false);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flush();
    });
    expect(container.textContent).toContain("macOS is blocking automatic paste");
    h.invoke.mockResolvedValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container.textContent).toBe("");
  });

  it("reports check failures and recovers on the next check", async () => {
    h.invoke.mockRejectedValue(new Error("Synthetic failure"));
    await render();
    expect(container.textContent).toContain("Typing permission couldn't be checked");
    h.invoke.mockResolvedValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flush();
    });
    expect(container.textContent).toBe("");
  });

  it("keeps manual recovery visible when opening Settings fails", async () => {
    await render();
    h.invoke.mockImplementation(async (command) => {
      if (command === "open_accessibility_settings") throw new Error("Synthetic failure");
      return false;
    });
    await act(async () => {
      container.querySelector("button")!.click();
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container.textContent).toContain("Couldn't open System Settings");
  });

  it("does not query macOS permission on other platforms", async () => {
    h.mac = false;
    await render();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("stops background checks after unmount", async () => {
    await render();
    await act(async () => root.render(null));
    h.invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
