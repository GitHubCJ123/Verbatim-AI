// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: h.writeText }));
vi.mock("../ui/Toast", () => ({ toast: { success: h.success, error: h.error } }));

import { DiagnosticsSettings } from "./DiagnosticsSettings";

const report = (enabled: boolean, generation: number, withEvent = false) => ({
  enabled,
  generation,
  appVersion: "0.5.17",
  platform: "synthetic",
  architecture: "synthetic",
  events: withEvent
    ? [{ recordedAtMs: 123, kind: "polish_failed", appVersion: [0, 5, 17], stage: null }]
    : [],
});

describe("local diagnostics settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    h.invoke.mockReset();
    h.writeText.mockReset().mockResolvedValue(undefined);
    h.success.mockReset();
    h.error.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(<DiagnosticsSettings />));
  }

  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  it("requires an explicit opt-in and deletes data when turned off", async () => {
    h.invoke.mockImplementation(async (command: string, args?: { enabled: boolean }) => {
      if (command === "get_diagnostics") return report(false, 10);
      if (command === "set_diagnostics_enabled") return report(args!.enabled, 11);
      if (command === "delete_diagnostics") return report(false, 12);
      throw new Error("Unexpected synthetic command");
    });
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Off by default");
    expect(container.textContent).toContain("even when transcript history is off");
    expect(container.textContent).toContain("stored unencrypted on this device");
    expect(container.textContent).toContain("nothing is uploaded");
    expect(container.textContent).toContain("hourly while running");
    await act(async () => toggle.click());
    expect(h.invoke).toHaveBeenCalledWith("set_diagnostics_enabled", { enabled: true });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click("Delete and turn off");
    expect(h.invoke).toHaveBeenCalledWith("delete_diagnostics");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(h.success).toHaveBeenCalledWith("Diagnostics deleted and turned off");
  });

  it("copies a refreshed, content-free report only on request", async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === "get_diagnostics") return report(true, 20, true);
      throw new Error("Unexpected synthetic command");
    });
    await render();
    expect(h.writeText).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Review diagnostics before copying");
    await click("Copy diagnostics");
    expect(h.invoke.mock.calls.filter(([command]) => command === "get_diagnostics")).toHaveLength(2);
    expect(h.writeText).toHaveBeenCalledOnce();
    const copied = JSON.parse(h.writeText.mock.calls[0][0]);
    expect(copied.events[0]).toMatchObject({ kind: "polish_failed", stage: null });
    expect(copied).not.toHaveProperty("generation");
    expect(JSON.stringify(copied)).not.toContain("transcript");
  });

  it("surfaces failed deletion and permits a retry without claiming success", async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === "get_diagnostics") return report(true, 30, true);
      if (command === "delete_diagnostics") throw new Error("Synthetic storage error");
      throw new Error("Unexpected synthetic command");
    });
    await render();
    await click("Delete and turn off");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("may still exist");
    expect(h.success).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    h.invoke.mockImplementation(async (command: string) => {
      if (command === "delete_diagnostics") return report(false, 31);
      throw new Error("Unexpected synthetic command");
    });
    await click("Delete and turn off");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(h.success).toHaveBeenCalledWith("Diagnostics deleted and turned off");
  });

  it("offers deletion when the stored journal cannot be read", async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === "get_diagnostics") throw new Error("Synthetic corrupt journal");
      if (command === "delete_diagnostics") return report(false, 40);
      throw new Error("Unexpected synthetic command");
    });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't be read");
    await click("Delete and turn off");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  });
});
