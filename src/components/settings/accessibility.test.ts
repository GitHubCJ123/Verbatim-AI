import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../ui/Toast", () => ({ toast: { error: h.toastError } }));

import { handleAccessibilityError } from "./accessibility";

describe("handleAccessibilityError", () => {
  beforeEach(() => {
    h.invoke.mockReset().mockResolvedValue(undefined);
    h.toastError.mockReset();
  });

  it("handles the needs-accessibility sentinel with a toast + registers + opens settings", () => {
    const handled = handleAccessibilityError(
      new Error("needs-accessibility: grant Accessibility to Verbatim AI ..."),
    );
    expect(handled).toBe(true);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("request_accessibility_permission");
    expect(h.invoke).toHaveBeenCalledWith("open_accessibility_settings");
  });

  it("also matches a raw string message", () => {
    expect(handleAccessibilityError("needs-accessibility")).toBe(true);
    expect(h.invoke).toHaveBeenCalledWith("open_accessibility_settings");
  });

  it("ignores unrelated errors: returns false, no toast or settings", () => {
    const handled = handleAccessibilityError(new Error("some other failure"));
    expect(handled).toBe(false);
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
