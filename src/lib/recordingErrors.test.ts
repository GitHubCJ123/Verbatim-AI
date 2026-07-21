import { describe, expect, it } from "vitest";
import { classifyRecordingError } from "./recordingErrors";

describe("classifyRecordingError", () => {
  it("classifies the known missing local Whisper model backend string", () => {
    expect(
      classifyRecordingError(
        "Model 'base.en' is not downloaded yet. Download it from Settings → AI model.",
      ),
    ).toMatchObject({
      kind: "missing-local-model",
      title: "No Whisper model installed",
      message: "Open Settings -> AI model to download a local transcription model.",
      actionTarget: "settings-ai-model",
      persistent: true,
    });
  });

  it("classifies Error instances for missing local Whisper models", () => {
    expect(
      classifyRecordingError(new Error("Model 'small' is not downloaded yet for Whisper")),
    ).toMatchObject({
      kind: "missing-local-model",
      title: "No Whisper model installed",
    });
  });

  it("does not classify unrelated transcription failures as missing model errors", () => {
    expect(classifyRecordingError("Transcription sidecar crashed before decoding audio")).toEqual({
      kind: "transcription",
      title: "Transcription failed",
      message: "Try recording again. If it keeps failing, check Settings -> AI model.",
    });
  });

  it("uses sanitized static user-facing copy instead of raw backend details", () => {
    const presentation = classifyRecordingError(
      "Model 'tiny.en' is not downloaded yet at /Users/alice/.cache/verbatim-ai/models/tiny.en.bin",
    );

    expect(presentation.message).not.toContain("tiny.en");
    expect(presentation.message).not.toContain("/Users/alice");
    expect(presentation.title).not.toContain("tiny.en");
  });

  it("handles unknown thrown values safely", () => {
    expect(classifyRecordingError({ reason: "Model 'base' is not downloaded yet" })).toEqual({
      kind: "transcription",
      title: "Transcription failed",
      message: "Try recording again. If it keeps failing, check Settings -> AI model.",
    });
  });

  it("handles message-shaped invoke failures", () => {
    expect(
      classifyRecordingError({
        message: "Model 'base.en' is not downloaded yet. Download it from Settings → AI model.",
      }),
    ).toMatchObject({
      kind: "missing-local-model",
      title: "No Whisper model installed",
    });
  });

  it("handles thrown values with a throwing string conversion safely", () => {
    const thrown = {
      toString() {
        throw new Error("boom");
      },
    };

    expect(classifyRecordingError(thrown)).toMatchObject({
      kind: "transcription",
      title: "Transcription failed",
    });
  });
});
