import { describe, expect, it } from "vitest";
import {
  effectivePasteMethodForOs,
  normalizePasteMethod,
  pasteMethodUsesClipboard,
} from "./pasteMethod";

describe("paste method preferences", () => {
  it("defaults invalid or missing values to auto", () => {
    expect(normalizePasteMethod(null)).toBe("auto");
    expect(normalizePasteMethod("bogus")).toBe("auto");
  });

  it("keeps explicit paste methods", () => {
    expect(normalizePasteMethod("ctrl-v")).toBe("ctrl-v");
    expect(normalizePasteMethod("shift-insert")).toBe("shift-insert");
    expect(normalizePasteMethod("direct")).toBe("direct");
  });

  it("uses direct as the Linux auto default", () => {
    expect(effectivePasteMethodForOs("auto", "linux")).toBe("direct");
    expect(pasteMethodUsesClipboard("auto", "linux")).toBe(false);
  });

  it("keeps clipboard paste as the non-Linux auto default", () => {
    expect(effectivePasteMethodForOs("auto", "macos")).toBe("ctrl-v");
    expect(effectivePasteMethodForOs("auto", "windows")).toBe("ctrl-v");
    expect(pasteMethodUsesClipboard("auto", "macos")).toBe(true);
  });
});
