/**
 * Local Whisper provider — runs transcription on-device via whisper.cpp
 * (Rust commands `transcribe_local`, `list_local_models`, etc).
 *
 * Cleanup is NOT yet implemented locally — we delegate to the cloud
 * cleanup function for now (Phase 2: local LLM via Ollama/llama.cpp).
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AIProvider,
  CleanupInput,
  ProviderHealth,
  TranscribeInput,
  TranscribeResult,
} from "./AIProvider";

export type WhisperTier = "tiny" | "base" | "small" | "turbo" | "large-v3";

export interface WhisperTierMeta {
  tier: WhisperTier;
  label: string;
  approxSizeMB: number;
  blurb: string;
  /** Suggested machine class. */
  recommendedFor: string;
}

export const WHISPER_TIERS: WhisperTierMeta[] = [
  {
    tier: "tiny",
    label: "Fast",
    approxSizeMB: 75,
    blurb: "Lowest accuracy, runs anywhere. Good for short English phrases.",
    recommendedFor: "Old laptops, ultra-low latency",
  },
  {
    tier: "base",
    label: "Light",
    approxSizeMB: 142,
    blurb: "Decent quality, very fast on any CPU.",
    recommendedFor: "Mid-range CPU, casual dictation",
  },
  {
    tier: "small",
    label: "Balanced",
    approxSizeMB: 466,
    blurb: "Solid accuracy across languages. Reasonable speed on modern CPUs.",
    recommendedFor: "Most modern laptops",
  },
  {
    tier: "turbo",
    label: "Recommended",
    approxSizeMB: 547,
    blurb: "Distilled large-v3. Near-SOTA accuracy at ~8× the speed. Best default.",
    recommendedFor: "Modern CPUs and GPUs",
  },
  {
    tier: "large-v3",
    label: "Max",
    approxSizeMB: 3100,
    blurb: "SOTA multilingual accuracy. Slow without a GPU.",
    recommendedFor: "Desktop GPU or Apple Silicon",
  },
];

export interface LocalModelInfo {
  tier: WhisperTier;
  installed: boolean;
  sizeBytes: number;
}

export async function listLocalModels(): Promise<LocalModelInfo[]> {
  const raw = await invoke<
    Array<{ tier: WhisperTier; installed: boolean; size_bytes: number }>
  >("list_local_models");
  return raw.map((r) => ({
    tier: r.tier,
    installed: r.installed,
    sizeBytes: r.size_bytes,
  }));
}

export function downloadLocalModel(tier: WhisperTier): Promise<void> {
  return invoke("download_local_model", { tier });
}

export function deleteLocalModel(tier: WhisperTier): Promise<void> {
  return invoke("delete_local_model", { tier });
}

export function isWhisperRuntimeInstalled(): Promise<boolean> {
  return invoke<boolean>("is_whisper_runtime_installed");
}

export function installWhisperRuntime(): Promise<void> {
  return invoke("install_whisper_runtime");
}

// Provider selection persisted in localStorage.
const LS_AI_PROVIDER = "sw.ai.provider";
const LS_LOCAL_WHISPER_TIER = "sw.ai.localWhisperTier";

export type AiProviderKind = "cloud" | "local-whisper";

export function getAiProviderKind(): AiProviderKind {
  return localStorage.getItem(LS_AI_PROVIDER) === "local-whisper"
    ? "local-whisper"
    : "cloud";
}

export function setAiProviderKind(v: AiProviderKind): void {
  localStorage.setItem(LS_AI_PROVIDER, v);
}

export function getLocalWhisperTier(): WhisperTier {
  const v = localStorage.getItem(LS_LOCAL_WHISPER_TIER);
  if (
    v === "tiny" ||
    v === "base" ||
    v === "small" ||
    v === "turbo" ||
    v === "large-v3"
  )
    return v;
  return "turbo";
}

export function setLocalWhisperTier(v: WhisperTier): void {
  localStorage.setItem(LS_LOCAL_WHISPER_TIER, v);
}

// Decode arbitrary audio Blob → 16 kHz mono Float32 PCM.
async function decodeToMonoF32_16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();
  const tmpCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    await tmpCtx.close();
  }
  const targetSampleRate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
  const off = new OfflineAudioContext(1, length, targetSampleRate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}

export interface LocalWhisperConfig {
  tier: WhisperTier;
  /** Provider used for the cleanup/polish step until local LLM ships. */
  cleanupFallback: AIProvider;
}

export class LocalWhisperProvider implements AIProvider {
  readonly name: string;
  constructor(private cfg: LocalWhisperConfig) {
    this.name = `Local Whisper (${cfg.tier})`;
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const samples = await decodeToMonoF32_16k(input.audio);
    const started = performance.now();
    const out = await invoke<{
      text: string;
      language_detected: string;
      duration_ms: number;
    }>("transcribe_local", {
      args: {
        tier: this.cfg.tier,
        language: input.language ?? null,
        translate: false,
        pcm: Array.from(samples),
      },
    });
    const wallMs = Math.round(performance.now() - started);
    return {
      text: out.text,
      languageDetected: out.language_detected || (input.language ?? "auto"),
      durationMs: out.duration_ms || wallMs,
    };
  }

  cleanup(input: CleanupInput): AsyncIterable<string> {
    return this.cfg.cleanupFallback.cleanup(input);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await listLocalModels();
      const target = models.find((m) => m.tier === this.cfg.tier);
      if (!target?.installed) {
        return {
          ok: false,
          message: `Model '${this.cfg.tier}' is not downloaded yet.`,
        };
      }
      return {
        ok: true,
        message: `Local Whisper (${this.cfg.tier}) ready (${(target.sizeBytes / 1024 / 1024).toFixed(0)} MB)`,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
