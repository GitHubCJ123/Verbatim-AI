/**
 * Parakeet TDT v3 provider — on-device multilingual transcription via the
 * sherpa-onnx CPU sidecar. This provider owns only the transcription half
 * of the pipeline.
 */
import { invoke } from "@tauri-apps/api/core";
import { decodeToMonoF32_16k } from "./audioDecode";
import type {
  ProviderHealth,
  Transcriber,
  TranscribeInput,
  TranscribeResult,
} from "./AIProvider";

const LS_PARAKEET_LANGUAGE = "sw.ai.parakeetLanguage";
const LS_PARAKEET_VARIANT = "sw.ai.parakeetVariant";

export type ParakeetVariant = "v2" | "v3";

export interface ParakeetVariantMeta {
  variant: ParakeetVariant;
  label: string;
  approxSizeMB: number;
  blurb: string;
  recommendedFor: string;
}

export const PARAKEET_VARIANTS: ParakeetVariantMeta[] = [
  {
    variant: "v2",
    label: "v2 — English",
    approxSizeMB: 640,
    blurb: "English-only. Slightly better English WER than v3 (~6.0%). Use this if you only speak English.",
    recommendedFor: "English speakers, max accuracy",
  },
  {
    variant: "v3",
    label: "v3 — Multilingual",
    approxSizeMB: 640,
    blurb: "25 European languages including English, French, German, Spanish, Italian, Russian. Auto-detects.",
    recommendedFor: "Multilingual use, default",
  },
];

export function getParakeetVariant(): ParakeetVariant {
  const v = localStorage.getItem(LS_PARAKEET_VARIANT);
  return v === "v2" ? "v2" : "v3";
}
export function setParakeetVariant(v: ParakeetVariant): void {
  localStorage.setItem(LS_PARAKEET_VARIANT, v);
}

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
  variant: ParakeetVariant;
  installed: boolean;
  sizeBytes: number;
}

export async function isParakeetRuntimeInstalled(): Promise<boolean> {
  return invoke<boolean>("is_parakeet_runtime_installed");
}

export function installParakeetRuntime(): Promise<void> {
  return invoke("install_parakeet_runtime");
}

export async function listParakeetModels(): Promise<ParakeetModelInfo[]> {
  const raw = await invoke<
    Array<{ variant: string; installed: boolean; size_bytes: number }>
  >("list_parakeet_models");
  return raw.map((r) => ({
    variant: (r.variant === "v2" ? "v2" : "v3") as ParakeetVariant,
    installed: r.installed,
    sizeBytes: r.size_bytes,
  }));
}

export async function isParakeetModelInstalled(
  variant: ParakeetVariant,
): Promise<ParakeetModelInfo> {
  const raw = await invoke<{ variant: string; installed: boolean; size_bytes: number }>(
    "is_parakeet_model_installed",
    { variant },
  );
  return {
    variant: (raw.variant === "v2" ? "v2" : "v3") as ParakeetVariant,
    installed: raw.installed,
    sizeBytes: raw.size_bytes,
  };
}

export function downloadParakeetModel(variant: ParakeetVariant): Promise<void> {
  return invoke("download_parakeet_model", { variant });
}

export function deleteParakeetModel(variant: ParakeetVariant): Promise<void> {
  return invoke("delete_parakeet_model", { variant });
}

export interface ParakeetConfig {
  variant: ParakeetVariant;
  language: string;
}

export class ParakeetProvider implements Transcriber {
  readonly name: string;
  constructor(private cfg: ParakeetConfig) {
    this.name = `Parakeet TDT ${cfg.variant}`;
  }

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
        variant: this.cfg.variant,
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

  async health(): Promise<ProviderHealth> {
    try {
      const [rt, model] = await Promise.all([
        isParakeetRuntimeInstalled(),
        isParakeetModelInstalled(this.cfg.variant),
      ]);
      if (!rt) return { ok: false, message: "Sherpa-onnx runtime not installed." };
      if (!model.installed)
        return { ok: false, message: `Parakeet ${this.cfg.variant} model not downloaded.` };
      return {
        ok: true,
        message: `Parakeet TDT ${this.cfg.variant} ready (${(model.sizeBytes / 1024 / 1024).toFixed(0)} MB)`,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
