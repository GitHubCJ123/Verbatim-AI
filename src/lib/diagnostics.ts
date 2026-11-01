import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DiagnosticStage = "capture" | "transcription" | "polish" | "delivery" | "review";

export type DiagnosticKind =
  | "unclean_exit"
  | "microphone_start_failed"
  | "microphone_capture_failed"
  | "speech_model_missing"
  | "transcription_failed"
  | "polish_failed"
  | "paste_target_missing"
  | "paste_permission_required"
  | "paste_activation_failed"
  | "paste_dispatch_failed"
  | "clipboard_write_failed"
  | "delivery_failed"
  | "delivery_confirmation_failed"
  | "history_write_failed"
  | "hotkey_registration_failed"
  | "main_window_error"
  | "overlay_window_error"
  | "main_unhandled_rejection"
  | "overlay_unhandled_rejection";

export interface DiagnosticEvent {
  recordedAtMs: number;
  kind: DiagnosticKind;
  appVersion: [number, number, number];
  stage: DiagnosticStage | null;
}

export interface DiagnosticReport {
  enabled: boolean;
  generation: number;
  appVersion: string;
  platform: string;
  architecture: string;
  events: DiagnosticEvent[];
}

interface TraceToken {
  generation: number;
  traceId: number;
}

interface DiagnosticPolicy {
  enabled: boolean;
  generation: number;
}

let policy: DiagnosticPolicy | null = null;

export interface DiagnosticTrace {
  setStage(stage: DiagnosticStage): void;
  finish(): void;
}

function warnUnavailable(): void {
  console.warn("[Verbatim AI] Local diagnostics are unavailable. Open Settings to resolve this.");
}

function applyPolicy(next: DiagnosticPolicy): boolean {
  if (
    !next ||
    typeof next.enabled !== "boolean" ||
    !Number.isInteger(next.generation) ||
    next.generation < 0 ||
    next.generation > 0xffffffff
  ) {
    warnUnavailable();
    return false;
  }
  if (policy && next.generation < policy.generation) return false;
  if (policy && next.generation === policy.generation && next.enabled !== policy.enabled) {
    policy = { enabled: false, generation: next.generation };
    warnUnavailable();
    return false;
  }
  policy = { enabled: next.enabled, generation: next.generation };
  return true;
}

function acceptReport(report: DiagnosticReport): DiagnosticReport {
  if (!applyPolicy(report)) throw new Error("Diagnostics changed; refresh and try again.");
  return report;
}

export async function getDiagnostics(): Promise<DiagnosticReport> {
  const report = await invoke<DiagnosticReport>("get_diagnostics");
  return acceptReport(report);
}

export async function setDiagnosticsEnabled(enabled: boolean): Promise<DiagnosticReport> {
  const report = await invoke<DiagnosticReport>("set_diagnostics_enabled", { enabled });
  return acceptReport(report);
}

export async function deleteDiagnostics(): Promise<DiagnosticReport> {
  const report = await invoke<DiagnosticReport>("delete_diagnostics");
  return acceptReport(report);
}

export function formatDiagnostics(report: DiagnosticReport): string {
  return JSON.stringify(
    {
      enabled: report.enabled,
      appVersion: report.appVersion,
      platform: report.platform,
      architecture: report.architecture,
      events: report.events,
    },
    null,
    2,
  );
}

export function recordDiagnostic(kind: Exclude<DiagnosticKind, "unclean_exit">): void {
  if (!policy?.enabled) return;
  void invoke("record_diagnostic_event", { kind, generation: policy.generation }).catch(
    warnUnavailable,
  );
}

export function beginDiagnosticTrace(): DiagnosticTrace {
  let pending = policy?.enabled
    ? invoke<TraceToken | null>("begin_diagnostic_trace", { generation: policy.generation }).catch(
        () => {
          warnUnavailable();
          return null;
        },
      )
    : Promise.resolve(null);
  const setStage = (stage: DiagnosticStage | null) => {
    pending = pending
      .then(async (trace) => {
        if (trace) await invoke("set_diagnostic_stage", { trace, stage });
        return trace;
      })
      .catch(() => {
        warnUnavailable();
        return null;
      });
  };
  return {
    setStage,
    finish: () => setStage(null),
  };
}

export function installUiDiagnostics(windowKind: "main" | "overlay"): () => void {
  let active = true;
  let removePolicyListener: (() => void) | null = null;
  const onError = () =>
    recordDiagnostic(windowKind === "main" ? "main_window_error" : "overlay_window_error");
  const onRejection = () =>
    recordDiagnostic(
      windowKind === "main" ? "main_unhandled_rejection" : "overlay_unhandled_rejection",
    );
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  void (async () => {
    const off = await listen<DiagnosticPolicy>("diagnostics:policy", (event) => {
      if (active) applyPolicy(event.payload);
    });
    if (!active) {
      off();
      return;
    }
    removePolicyListener = off;
    const current = await invoke<DiagnosticPolicy>("get_diagnostics_policy");
    if (active) applyPolicy(current);
  })().catch(() => {
    if (active) warnUnavailable();
  });
  return () => {
    active = false;
    removePolicyListener?.();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
