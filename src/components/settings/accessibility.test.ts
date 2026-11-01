import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn((_command: string): Promise<void> => Promise.resolve()),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../ui/Toast", () => ({ toast: { error: h.toastError, info: h.toastInfo } }));

import { handleAccessibilityError, openPastePermissionSettings } from "./accessibility";

describe("handleAccessibilityError", () => {
  beforeEach(() => {
    h.invoke.mockReset().mockResolvedValue(undefined);
    h.toastError.mockReset();
    h.toastInfo.mockReset();
  });

  it("explains both macOS labels before requesting permission and opening settings", async () => {
    const handled = handleAccessibilityError(
      new Error("needs-accessibility: grant Accessibility to Verbatim AI ..."),
    );
    expect(handled).toBe(true);
    expect(h.toastInfo).toHaveBeenCalledWith(
      "Allow typing into other apps",
      expect.objectContaining({
        duration: Infinity,
        description: expect.stringContaining("Device Control and Data Access"),
      }),
    );
    const options = h.toastInfo.mock.calls[0][1];
    expect(options.description).toContain("Accessibility on older macOS versions");
    expect(h.invoke).not.toHaveBeenCalled();
    options.action.onClick();
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith("open_accessibility_settings"));
    expect(h.invoke).toHaveBeenCalledWith("request_accessibility_permission");
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "request_accessibility_permission",
      "open_accessibility_settings",
    ]);
  });

  it("also matches a raw string message", () => {
    expect(handleAccessibilityError("needs-accessibility")).toBe(true);
    expect(h.toastInfo).toHaveBeenCalledTimes(1);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("ignores unrelated errors: returns false, no toast or settings", () => {
    const handled = handleAccessibilityError(new Error("some other failure"));
    expect(handled).toBe(false);
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.toastInfo).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it.each(["request_accessibility_permission", "open_accessibility_settings"])(
    "shows manual recovery when %s fails",
    async (failedCommand) => {
      h.invoke.mockImplementation((command) =>
        command === failedCommand
          ? Promise.reject(new Error("Synthetic IPC failure"))
          : Promise.resolve(),
      );
      handleAccessibilityError("needs-accessibility");
      h.toastInfo.mock.calls[0][1].action.onClick();
      await vi.waitFor(() =>
        expect(h.toastError).toHaveBeenCalledWith(
          "Couldn't open permission settings",
          expect.objectContaining({
            description: expect.stringContaining("Device Control and Data Access"),
          }),
        ),
      );
    },
  );

  it("waits for registration before opening the pane", async () => {
    let registered!: () => void;
    h.invoke.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        registered = resolve;
      }),
    );
    const opening = openPastePermissionSettings();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    registered();
    await opening;
    expect(h.invoke).toHaveBeenNthCalledWith(2, "open_accessibility_settings");
  });
});
