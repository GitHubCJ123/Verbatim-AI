import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(() => Promise.resolve()),
  readText: vi.fn(() => Promise.resolve("prev-clip")),
  recordDiagnostic: vi.fn(),
  behavior: "copy" as "copy" | "insert-only" | "restore",
  method: "auto" as string,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: h.writeText,
  readText: h.readText,
}));
vi.mock("./os", () => ({ osKind: () => "macos" }));
vi.mock("./diagnostics", () => ({ recordDiagnostic: h.recordDiagnostic }));
vi.mock("./preferences", () => ({
  getOutputBehavior: () => h.behavior,
  getPasteMethod: () => h.method,
}));

import { copyCleanedText, pasteCleanedText } from "./output";

describe("pasteCleanedText outcome mapping", () => {
  beforeEach(() => {
    h.invoke.mockReset();
    h.writeText.mockReset().mockResolvedValue(undefined);
    h.readText.mockReset().mockResolvedValue("prev-clip");
    h.recordDiagnostic.mockReset();
    h.behavior = "copy";
    h.method = "auto";
  });

  it("maps a successful paste to 'pasted'", async () => {
    h.invoke.mockResolvedValue(true);
    await expect(pasteCleanedText("hi")).resolves.toBe("pasted");
    expect(h.recordDiagnostic).not.toHaveBeenCalled();
  });

  it("maps Ok(false) to 'no-target'", async () => {
    h.invoke.mockResolvedValue(false);
    await expect(pasteCleanedText("hi")).resolves.toBe("no-target");
    expect(h.recordDiagnostic).toHaveBeenCalledWith("paste_target_missing");
  });

  it("maps the needs-accessibility sentinel to 'permission-required'", async () => {
    h.invoke.mockRejectedValue(new Error("needs-accessibility: grant Accessibility ..."));
    await expect(pasteCleanedText("hi")).resolves.toBe("permission-required");
    expect(h.recordDiagnostic).toHaveBeenCalledWith("paste_permission_required");
  });

  it("maps the target-activation-failed sentinel to 'activation-failed'", async () => {
    h.invoke.mockRejectedValue(new Error("target-activation-failed: couldn't switch back ..."));
    await expect(pasteCleanedText("hi")).resolves.toBe("activation-failed");
    expect(h.recordDiagnostic).toHaveBeenCalledWith("paste_activation_failed");
  });

  it("maps an unknown error to 'failed'", async () => {
    h.invoke.mockRejectedValue(new Error("boom"));
    await expect(pasteCleanedText("hi")).resolves.toBe("failed");
    expect(h.recordDiagnostic).toHaveBeenCalledWith("paste_dispatch_failed");
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

  it("records only a fixed category when clipboard writing fails", async () => {
    h.writeText.mockRejectedValue(new Error("Synthetic private clipboard error"));
    await expect(copyCleanedText("Synthetic private text")).rejects.toThrow();
    expect(h.recordDiagnostic).toHaveBeenCalledExactlyOnceWith("clipboard_write_failed");
  });
});
