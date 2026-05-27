/**
 * Parakeet TDT v3 provider — on-device multilingual transcription via the
 * sherpa-onnx CPU sidecar. Cleanup is delegated to whatever cleanup
 * provider the user has selected (cloud or Ollama), mirroring the Local
 * Whisper provider's pattern.
 */
import { invoke } from "@tauri-apps/api/core";
import { decodeToMonoF32_16k } from "./audioDecode";
import type {
  AIProvider,
  CleanupInput,
  ProviderHealth,
  TranscribeInput,
  TranscribeResult,
} from "./AIProvider";

const LS_PARAKEET_LANGUAGE = "sw.ai.parakeetLanguage";

/** 25 European languages supported by Parakeet TDT v3, plus auto-detect. */
export interface ParakeetLanguage {
  code: string;
  label: string;
}

export const PARAKEET_LANGUAGES: ParakeetLanguage[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "sv", label: "Swedish" },
  { code: "da", label: "Danish" },
  { code: "fi", label: "Finnish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "el", label: "Greek" },
  { code: "hu", label: "Hungarian" },
  { code: "cs", label: "Czech" },
  { code: "bg", label: "Bulgarian" },
  { code: "hr", label: "Croatian" },
  { code: "et", label: "Estonian" },
  { code: "lv", label: "Latvian" },
  { code: "lt", label: "Lithuanian" },
  { code: "mt", label: "Maltese" },
  { code: "ro", label: "Romanian" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
];

export function getParakeetLanguage(): string {
  return localStorage.getItem(LS_PARAKEET_LANGUAGE) || "auto";
}
export function setParakeetLanguage(code: string): void {
  localStorage.setItem(LS_PARAKEET_LANGUAGE, code);
}

export interface ParakeetModelInfo {
  installed: boolean;
  sizeBytes: number;
}

export async function isParakeetRuntimeInstalled(): Promise<boolean> {
  return invoke<boolean>("is_parakeet_runtime_installed");
}

export function installParakeetRuntime(): Promise<void> {
  return invoke("install_parakeet_runtime");
}

export async function isParakeetModelInstalled(): Promise<ParakeetModelInfo> {
  const raw = await invoke<{ installed: boolean; size_bytes: number }>(
    "is_parakeet_model_installed",
  );
  return { installed: raw.installed, sizeBytes: raw.size_bytes };
}

export function downloadParakeetModel(): Promise<void> {
  return invoke("download_parakeet_model");
}

export function deleteParakeetModel(): Promise<void> {
  return invoke("delete_parakeet_model");
}

export interface ParakeetConfig {
  language: string;
  /** Provider used for the cleanup step (Parakeet itself doesn't clean up). */
  cleanupFallback: AIProvider;
}

export class ParakeetProvider implements AIProvider {
  readonly name = "Parakeet TDT v3";
  constructor(private cfg: ParakeetConfig) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const samples = await decodeToMonoF32_16k(input.audio);
    const started = performance.now();
    const language = input.language ?? this.cfg.language;
    const out = await invoke<{
      text: string;
      language_detected: string;
      duration_ms: number;
    }>("transcribe_parakeet", {
      args: {
        pcm: Array.from(samples),
        language: language === "auto" ? null : language,
      },
    });
    const wallMs = Math.round(performance.now() - started);
    return {
      text: out.text,
      languageDetected: out.language_detected || language,
      durationMs: out.duration_ms || wallMs,
    };
  }

  cleanup(input: CleanupInput): AsyncIterable<string> {
    return this.cfg.cleanupFallback.cleanup(input);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const [rt, model] = await Promise.all([
        isParakeetRuntimeInstalled(),
        isParakeetModelInstalled(),
      ]);
      if (!rt) return { ok: false, message: "Sherpa-onnx runtime not installed." };
      if (!model.installed)
        return { ok: false, message: "Parakeet v3 model not downloaded." };
      return {
        ok: true,
        message: `Parakeet TDT v3 ready (${(model.sizeBytes / 1024 / 1024).toFixed(0)} MB)`,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
