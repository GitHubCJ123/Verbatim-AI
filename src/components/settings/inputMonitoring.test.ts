import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../ui/Toast", () => ({ toast: { error: h.toastError } }));

import { handleInputMonitoringError } from "./inputMonitoring";

describe("handleInputMonitoringError", () => {
  beforeEach(() => {
    h.invoke.mockReset().mockResolvedValue(undefined);
    h.toastError.mockReset();
  });

  it("handles the needs-input-monitoring sentinel with a toast + opens settings", () => {
    const handled = handleInputMonitoringError(
      new Error("needs-input-monitoring: grant Input Monitoring to Verbatim AI ..."),
    );
    expect(handled).toBe(true);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("open_input_monitoring_settings");
  });

  it("also matches a raw string message", () => {
    expect(handleInputMonitoringError("needs-input-monitoring")).toBe(true);
    expect(h.invoke).toHaveBeenCalledWith("open_input_monitoring_settings");
  });

  it("ignores unrelated errors: returns false, no toast or settings", () => {
    const handled = handleInputMonitoringError(new Error("some other failure"));
    expect(handled).toBe(false);
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
