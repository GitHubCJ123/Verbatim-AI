export type RecordingErrorKind =
  | "missing-local-model"
  | "transcription"
  | "cleanup"
  | "recording"
  | "unknown";

export type RecordingErrorPresentation = {
  kind: RecordingErrorKind;
  title: string;
  message: string;
  actionLabel?: string;
  actionTarget?: "settings-ai-model";
  persistent?: boolean;
};

export type RecordingErrorRelayPayload = RecordingErrorPresentation;

const MISSING_LOCAL_MODEL_PRESENTATION: RecordingErrorPresentation = {
  kind: "missing-local-model",
  title: "No Whisper model installed",
  message: "Open Settings -> AI model to download a local transcription model.",
  actionLabel: "Open Settings",
  actionTarget: "settings-ai-model",
  persistent: true,
};

const TRANSCRIPTION_ERROR_PRESENTATION: RecordingErrorPresentation = {
  kind: "transcription",
  title: "Transcription failed",
  message: "Try recording again. If it keeps failing, check Settings -> AI model.",
};

function normalizeErrorText(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
      return String(error);
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return error.message;
    }
    return "";
  } catch {
    return "";
  }
}

function looksLikeMissingLocalWhisperModel(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.includes("model") || !normalized.includes("not downloaded")) return false;
  if (normalized.includes("whisper")) return true;
  if (normalized.includes("settings") && normalized.includes("ai model")) return true;
  return /^model ['"][^'"]+['"] is not downloaded yet\b/.test(normalized);
}

export function classifyRecordingError(error: unknown): RecordingErrorPresentation {
  const text = normalizeErrorText(error);
  if (looksLikeMissingLocalWhisperModel(text)) {
    return MISSING_LOCAL_MODEL_PRESENTATION;
  }
  return TRANSCRIPTION_ERROR_PRESENTATION;
}
