// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", async () => {
  const { createElement } = await import("react");
  return {
    motion: {
      div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
        createElement("div", { className }, children),
      span: ({ children, className }: { children: React.ReactNode; className?: string }) =>
        createElement("span", { className }, children),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

const h = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: Record<string, unknown> }) => unknown>(),
  stop: vi.fn(),
  transcribe: vi.fn(),
  paste: vi.fn(),
  copy: vi.fn(),
  addVocabulary: vi.fn(),
  invoke: vi.fn(),
  hide: vi.fn(),
  reviewResize: vi.fn(),
  streaming: false,
  ack: "skipped",
  realMain: false,
  improve: false,
  cleanupReject: false,
  diagnosticGeneration: 100,
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  onPartial: null as null | ((partial: { text: string }) => void),
  mode: {
    id: "synthetic-mode",
    name: "Synthetic",
    language: "en",
    outputStyle: "paste",
    skipCleanup: true,
    saveHistory: false,
    systemPrompt: "",
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    callback: (event: { payload: Record<string, unknown> }) => unknown,
  ) => {
    h.listeners.set(name, callback);
    return () => h.listeners.delete(name);
  },
  emit: vi.fn(async (name: string, payload: Record<string, unknown>) => {
    h.listeners.get(name)?.({ payload });
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide: h.hide, setFocus: async () => {} }),
}));
vi.mock("../lib/audio", () => ({
  startRecording: async () => ({ stop: h.stop, cancel: vi.fn(), getBars: () => [] }),
}));
vi.mock("../lib/ai", () => ({
  getActiveProvider: () => ({
    transcribe: h.transcribe,
    cleanup: async function* () {
      yield "Synthetic streamed polish.";
      if (h.cleanupReject) throw new Error("Synthetic cleanup failure");
    },
  }),
}));
vi.mock("../lib/store/useModes", () => ({
  getModeById: () => h.mode,
  getDefaultMode: () => h.mode,
  loadVocabulary: () => [],
  useVocabulary: (select: (state: { add: typeof h.addVocabulary }) => unknown) =>
    select({ add: h.addVocabulary }),
}));
vi.mock("../lib/recording-bridge", () => ({
  resizeOverlayToReview: h.reviewResize,
  resizeOverlayToPill: async () => {},
}));
vi.mock("../lib/output", () => ({
  pasteCleanedText: h.paste,
  copyCleanedText: h.copy,
  clearCapturedTarget: async () => {},
}));
vi.mock("../lib/os", () => ({ osKind: () => "macos" }));
vi.mock("../lib/privacyStatus", () => ({ getPrivacyStatus: () => ({ overall: "local" }) }));
vi.mock("../lib/vad/speechModel", () => ({
  warmupSpeechModel: vi.fn(),
  getReadyRealtimeSpeechModel: () => undefined,
  getTrimSpeechModel: async () => undefined,
}));
vi.mock("../lib/transcribe/streamingClient", () => ({
  isStreamingSidecarAvailable: async () => true,
  StreamingTranscriber: class {
    constructor(options: { onPartial: (partial: { text: string }) => void }) {
      h.onPartial = options.onPartial;
    }
    async start() {}
    async dispose() {}
    push() {}
  },
}));
vi.mock("../lib/ai/localWhisper", () => ({
  getLocalWhisperTier: () => "tiny",
  getWhisperComputePreference: () => "cpu",
}));
vi.mock("../lib/preferences", () => ({
  isAiImproveDisabled: () => !h.improve,
  getMicDeviceId: () => "",
  getOutputBehavior: () => "clipboard",
  getPasteMethod: () => "clipboard",
  isPerfDebugEnabled: () => false,
  isSilenceTrimEnabled: () => false,
  isAutoStopEnabled: () => false,
  isFillerFilterEnabled: () => false,
  isFuzzyVocabEnabled: () => false,
  isLivePartialEnabled: () => false,
  isTrueStreamingEnabled: () => h.streaming,
  isHistoryDisabled: () => false,
  getHistoryRetentionDays: () => null,
}));
vi.mock("../components/ui/Toast", () => ({ toast: h.toast }));
vi.mock("../lib/appMode", () => ({ isLocalMode: () => true }));
vi.mock("../lib/supabase", () => ({ supabase: {} }));
vi.mock("../lib/store/useAuth", () => ({ useAuth: { getState: () => ({ user: null }) } }));
import Overlay from "./Overlay";
import { installRecordingResultListeners } from "../lib/recordingResults";
import { listTranscriptions } from "../lib/history";
import { getDiagnostics, setDiagnosticsEnabled } from "../lib/diagnostics";

let container: HTMLDivElement;
let root: Root;
async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
async function fire(name: string, payload: Record<string, unknown> = {}) {
  await act(async () => {
    h.listeners.get(name)!({ payload });
    await flush();
  });
}
async function start() {
  await act(async () => {
    root.render(<Overlay />);
    await flush();
  });
  await fire("recording:start", { modeName: "Synthetic", sessionId: 1 });
}
async function dictate() {
  await start();
  await fire("recording:stop");
}
function editor() {
  const textarea = container.querySelector("textarea");
  expect(textarea).not.toBeNull();
  return textarea!;
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await flush();
  });
}

async function enableDiagnostics() {
  const generation = (h.diagnosticGeneration += 2);
  const existing = h.invoke.getMockImplementation();
  h.invoke.mockImplementation(async (command, args) => {
    const report = (enabled: boolean, version: number) => ({
      enabled,
      generation: version,
      appVersion: "0.5.17",
      platform: "synthetic",
      architecture: "synthetic",
      events: [],
    });
    if (command === "get_diagnostics") return report(true, generation);
    if (command === "set_diagnostics_enabled") return report(false, generation + 1);
    if (command === "begin_diagnostic_trace") return { generation, traceId: 1 };
    return existing?.(command, args);
  });
  await getDiagnostics();
  return generation;
}

describe("Overlay delivery at real recording and Review callbacks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    h.listeners.clear();
    h.mode.outputStyle = "paste";
    h.streaming = false;
    h.onPartial = null;
    h.ack = "skipped";
    h.realMain = false;
    h.mode.saveHistory = false;
    h.mode.skipCleanup = true;
    h.improve = false;
    h.cleanupReject = false;
    localStorage.clear();
    h.stop.mockReset().mockResolvedValue({ blob: new Blob(), durationMs: 1000 });
    h.transcribe
      .mockReset()
      .mockResolvedValue({ text: "Synthetic dictation.", languageDetected: "en" });
    h.paste.mockReset().mockResolvedValue("pasted");
    h.copy.mockReset().mockResolvedValue(undefined);
    h.hide.mockReset().mockResolvedValue(undefined);
    h.reviewResize.mockReset().mockResolvedValue(undefined);
    h.invoke.mockReset().mockImplementation(async (_command, args) => {
      if (args?.name === "recording:result" || args?.name === "recording:reviewed") {
        if (h.realMain) await h.listeners.get(args.name)?.({ payload: args.payload });
        else
          h.listeners.get("recording:delivery-ack")?.({
            payload: { emitId: args.payload.emitId, status: h.ack },
          });
      }
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retains clipboard-permission failures as copied results, never pasted", async () => {
    h.paste.mockResolvedValue("permission-required");
    await dictate();
    expect(h.invoke).toHaveBeenCalledWith(
      "relay_event",
      expect.objectContaining({
        name: "recording:result",
        payload: expect.objectContaining({
          cleaned: "Synthetic dictation.",
          outputAction: "copied",
        }),
      }),
    );
    expect(editor().value).toBe("Synthetic dictation.");
    expect(container.textContent).toContain("Copy");
  });

  it("explains how to add the app when Accessibility is missing", async () => {
    h.paste.mockResolvedValue("permission-required");
    await dictate();
    expect(container.textContent).toContain("Allow typing into other apps");
    expect(container.textContent).toContain("Device Control and Data Access");
    expect(container.textContent).toContain("Accessibility on older macOS versions");
    expect(container.textContent).toContain("If it isn't listed, click +");
    expect(container.textContent).toContain("add Verbatim AI.app (usually in Applications)");
    expect(h.invoke).not.toHaveBeenCalledWith("request_accessibility_permission");
    await click("Open Settings");
    expect(h.invoke).toHaveBeenCalledWith("request_accessibility_permission");
    expect(h.invoke).toHaveBeenCalledWith("open_accessibility_settings");
  });

  it("keeps text and provides manual instructions if Settings cannot open", async () => {
    h.paste.mockResolvedValue("permission-required");
    await dictate();
    const original = h.invoke.getMockImplementation();
    h.invoke.mockImplementation((command, args) => {
      if (command === "open_accessibility_settings")
        return Promise.reject(new Error("Synthetic failure"));
      return original?.(command, args);
    });
    await click("Open Settings");
    expect(container.textContent).toContain("Couldn't open permission settings");
    expect(container.textContent).toContain("Device Control and Data Access");
    expect(editor().value).toBe("Synthetic dictation.");
    expect(h.hide).not.toHaveBeenCalled();
    await click("Copy");
    expect(h.copy).toHaveBeenCalledWith("Synthetic dictation.");
  });

  it("guides a manual Review paste permission failure without prompting automatically", async () => {
    h.mode.outputStyle = "review";
    await dictate();
    h.paste.mockResolvedValue("permission-required");
    await click("Paste");
    expect(container.textContent).toContain("Allow typing into other apps");
    expect(h.invoke).not.toHaveBeenCalledWith("request_accessibility_permission");
    expect(editor().value).toBe("Synthetic dictation.");
    await click("Open Settings");
    expect(h.invoke).toHaveBeenCalledWith("request_accessibility_permission");
    expect(h.invoke).toHaveBeenCalledWith("open_accessibility_settings");
  });

  it.each(["transcribe", "stop"])(
    "recovers an available live preview when %s rejects",
    async (stage) => {
      h.streaming = true;
      await start();
      expect(h.onPartial).not.toBeNull();
      await act(async () => {
        h.onPartial!({ text: "Synthetic partial." });
      });
      (stage === "stop" ? h.stop : h.transcribe).mockRejectedValue(new Error("Synthetic failure"));
      await fire("recording:stop");
      expect(editor().value).toBe("Synthetic partial.");
      expect(container.textContent).toContain("incomplete live preview");
    },
  );

  it("keeps a failed Copy in Review without losing an edit", async () => {
    h.mode.outputStyle = "review";
    await dictate();
    const textarea = editor();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "Synthetic edit.",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    h.copy.mockRejectedValue(new Error("Synthetic clipboard failure"));
    await click("Copy");
    expect(container.textContent).toContain("Copy didn't finish");
    expect(editor().value).toBe("Synthetic edit.");
    expect(h.hide).not.toHaveBeenCalled();
  });

  it("reports Copied for a clipboard-only miss", async () => {
    h.paste.mockResolvedValue("no-target");
    await dictate();
    expect(container.textContent).toContain("Copied");
    expect(container.textContent).not.toContain("Done");
  });

  it("opens Review when history fails after a successful paste", async () => {
    h.ack = "failed";
    await dictate();
    expect(editor().value).toBe("Synthetic dictation.");
    expect(h.hide).not.toHaveBeenCalled();
    expect(h.paste).toHaveBeenCalledTimes(1);
  });

  it("retains the transcript rather than partial polish when cleanup fails", async () => {
    h.improve = true;
    h.cleanupReject = true;
    h.mode.skipCleanup = false;
    await dictate();
    expect(editor().value).toBe("Synthetic dictation.");
    expect(container.textContent).toContain("AI polish didn't finish");
    expect(h.paste).not.toHaveBeenCalled();
  });

  it("does not allow the Review shortcut during delivery", async () => {
    h.mode.outputStyle = "review";
    await dictate();
    let finish!: () => void;
    h.copy.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await click("Copy");
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(h.paste).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await flush();
    });
    expect(h.copy).toHaveBeenCalledTimes(1);
  });

  it("recovers at the overlay → main event → real local-history seam", async () => {
    h.realMain = true;
    h.mode.saveHistory = true;
    await installRecordingResultListeners();
    const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Synthetic quota failure");
    });
    await dictate();
    expect(editor().value).toBe("Synthetic dictation.");
    expect(container.textContent).toContain("Pasted, but");
    expect(await listTranscriptions()).toEqual([]);
    expect(h.toast.error).toHaveBeenCalledWith("History wasn't saved", expect.any(Object));
    quota.mockRestore();
    await click("Copy");
    expect((await listTranscriptions())[0]).toMatchObject({
      cleaned_text: "Synthetic dictation.",
      output_action: "copied",
    });
    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.hide).toHaveBeenCalledTimes(1);
  });

  it("suppresses intentional blank audio without recovery or delivery", async () => {
    h.transcribe.mockResolvedValue({ text: "[BLANK_AUDIO]", languageDetected: "en" });
    await dictate();
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.reviewResize).not.toHaveBeenCalled();
    expect(h.invoke.mock.calls.filter(([, args]) => args?.name === "recording:result")).toEqual([]);
  });

  it("does not overwrite unresolved Review with a new dictation", async () => {
    h.mode.outputStyle = "review";
    await dictate();
    await fire("recording:start", { modeName: "New", sessionId: 2 });
    expect(editor().value).toBe("Synthetic dictation.");
    expect(h.transcribe).toHaveBeenCalledTimes(1);
  });

  it("records a fixed transcription failure without any private error or text", async () => {
    const generation = await enableDiagnostics();
    h.transcribe.mockRejectedValue(new Error("Synthetic private transcript and path"));
    await dictate();
    expect(h.invoke).toHaveBeenCalledWith("record_diagnostic_event", {
      kind: "transcription_failed",
      generation,
    });
    const diagnosticCalls = h.invoke.mock.calls.filter(([command]) =>
      ["begin_diagnostic_trace", "set_diagnostic_stage", "record_diagnostic_event"].includes(
        command,
      ),
    );
    expect(JSON.stringify(diagnosticCalls)).not.toContain("Synthetic private");
    expect(diagnosticCalls).toContainEqual([
      "set_diagnostic_stage",
      { trace: { generation, traceId: 1 }, stage: "transcription" },
    ]);
    await setDiagnosticsEnabled(false);
  });

  it("returns to the Review stage after successful polish", async () => {
    const generation = await enableDiagnostics();
    h.mode.outputStyle = "review";
    h.mode.skipCleanup = false;
    h.improve = true;
    await dictate();
    const stages = h.invoke.mock.calls
      .filter(([command]) => command === "set_diagnostic_stage")
      .map(([, args]) => args.stage);
    expect(stages).toContain("polish");
    expect(stages[stages.length - 1]).toBe("review");
    expect(h.invoke).toHaveBeenCalledWith("begin_diagnostic_trace", { generation });
    await setDiagnosticsEnabled(false);
  });

  it("does not mislabel an output failure as a transcription failure", async () => {
    const generation = await enableDiagnostics();
    h.paste.mockRejectedValue(new Error("Synthetic private output failure"));
    await dictate();
    expect(h.invoke).toHaveBeenCalledWith("record_diagnostic_event", {
      kind: "delivery_failed",
      generation,
    });
    expect(h.invoke).not.toHaveBeenCalledWith("record_diagnostic_event", {
      kind: "transcription_failed",
      generation,
    });
    await setDiagnosticsEnabled(false);
  });
});
