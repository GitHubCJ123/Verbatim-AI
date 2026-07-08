import type { OsKind } from "./os";

export type PasteMethod = "auto" | "ctrl-v" | "shift-insert" | "direct";

export const PASTE_METHODS: PasteMethod[] = ["auto", "ctrl-v", "shift-insert", "direct"];

export function normalizePasteMethod(value: string | null): PasteMethod {
  return PASTE_METHODS.includes(value as PasteMethod) ? (value as PasteMethod) : "auto";
}

export function effectivePasteMethodForOs(method: PasteMethod, os: OsKind): PasteMethod {
  if (method !== "auto") return method;
  return os === "linux" ? "direct" : "ctrl-v";
}

export function pasteMethodUsesClipboard(method: PasteMethod, os: OsKind): boolean {
  return effectivePasteMethodForOs(method, os) !== "direct";
}
