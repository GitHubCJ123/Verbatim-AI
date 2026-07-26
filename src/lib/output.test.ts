import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(() => Promise.resolve()),
  readText: vi.fn(() => Promise.resolve("prev-clip")),
  behavior: "copy" as "copy" | "insert-only" | "restore",
  method: "auto" as string,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: h.writeText,
  readText: h.readText,
}));
vi.mock("./os", () => ({ osKind: () => "macos" }));
vi.mock("./preferences", () => ({
  getOutputBehavior: () => h.behavior,
  getPasteMethod: () => h.method,
}));

import { pasteCleanedText } from "./output";

describe("pasteCleanedText outcome mapping", () => {
  beforeEach(() => {
    h.invoke.mockReset();
    h.writeText.mockReset().mockResolvedValue(undefined);
    h.readText.mockReset().mockResolvedValue("prev-clip");
    h.behavior = "copy";
    h.method = "auto";
  });

  it("maps a successful paste to 'pasted'", async () => {
    h.invoke.mockResolvedValue(true);
    await expect(pasteCleanedText("hi")).resolves.toBe("pasted");
  });

  it("maps Ok(false) to 'no-target'", async () => {
    h.invoke.mockResolvedValue(false);
    await expect(pasteCleanedText("hi")).resolves.toBe("no-target");
  });

  it("maps the needs-accessibility sentinel to 'permission-required'", async () => {
    h.invoke.mockRejectedValue(new Error("needs-accessibility: grant Accessibility ..."));
    await expect(pasteCleanedText("hi")).resolves.toBe("permission-required");
  });

  it("maps the target-activation-failed sentinel to 'activation-failed'", async () => {
    h.invoke.mockRejectedValue(new Error("target-activation-failed: couldn't switch back ..."));
    await expect(pasteCleanedText("hi")).resolves.toBe("activation-failed");
  });

  it("maps an unknown error to 'failed'", async () => {
    h.invoke.mockRejectedValue(new Error("boom"));
    await expect(pasteCleanedText("hi")).resolves.toBe("failed");
  });

  it("surfaces permission-required for insert-only (direct, no clipboard)", async () => {
    h.behavior = "insert-only";
    h.invoke.mockRejectedValue(new Error("needs-accessibility: ..."));
    await expect(pasteCleanedText("hi")).resolves.toBe("permission-required");
    // Direct typing must not touch the clipboard.
    expect(h.writeText).not.toHaveBeenCalled();
  });

  it("surfaces permission-required for restore behavior and restores the clipboard", async () => {
    h.behavior = "restore";
    h.readText.mockResolvedValue("original");
    // After we write "hi", the clipboard reads back "hi" so the restore fires.
    h.invoke.mockRejectedValue(new Error("needs-accessibility: ..."));
    h.readText.mockResolvedValueOnce("original"); // initial capture
    h.readText.mockResolvedValueOnce("hi"); // current value during restore check
    await expect(pasteCleanedText("hi")).resolves.toBe("permission-required");
    expect(h.writeText).toHaveBeenCalledWith("hi"); // wrote the dictation
    expect(h.writeText).toHaveBeenCalledWith("original"); // restored the prior clipboard
  });
});
