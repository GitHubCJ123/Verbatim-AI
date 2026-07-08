import { describe, expect, it, vi } from "vitest";

// hotkey.ts pulls in the recording pipeline and tauri IPC at import
// time; stub the surface so we can exercise its pure spec helpers.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("./recording-bridge", () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  cancelRecording: vi.fn(),
}));
vi.mock("./modeResolver", () => ({ resolveModeAtPress: vi.fn() }));
vi.mock("./preferences", () => ({ isHotkeyPaused: vi.fn(() => false) }));
vi.mock("./store/useOnboarding", () => ({ isOnboardingComplete: vi.fn(() => true) }));
vi.mock("./ai/localWhisper", () => ({
  ensureWhisperEngineReady: vi.fn(),
  getAiProviderKind: vi.fn(),
  getLocalWhisperEngine: vi.fn(),
  getLocalWhisperTier: vi.fn(),
}));

import {
  hotkeyDisplayParts,
  isSingleKeySpec,
  usesHoldToTalk,
} from "./hotkey";

describe("hotkey spec helpers — modifier-only triggers", () => {
  it("treats the fn and Right ⌘ sentinels as single-key specs", () => {
    expect(isSingleKeySpec("Fn")).toBe(true);
    expect(isSingleKeySpec("RightCommand")).toBe(true);
    expect(isSingleKeySpec("Control+Shift+Space")).toBe(false);
  });

  it("renders the Right ⌘ sentinel as a single labelled part", () => {
    // The sentinel has no '+', so it must survive as one display token
    // (the exact glyph varies by platform label map).
    expect(hotkeyDisplayParts("RightCommand")).toHaveLength(1);
    expect(hotkeyDisplayParts("Control+Space")).toHaveLength(2);
  });

  it("forces hold-to-talk when push-to-talk is enabled, regardless of spec", () => {
    expect(usesHoldToTalk({ spec: "RightCommand", pushToTalk: true })).toBe(true);
    expect(usesHoldToTalk({ spec: "Control+Space", pushToTalk: true })).toBe(true);
  });

  it("does not force hold-to-talk for a multi-key toggle spec", () => {
    expect(usesHoldToTalk({ spec: "Control+Shift+Space", pushToTalk: false })).toBe(false);
  });
});
