/**
 * Local Whisper provider — runs transcription on-device via whisper.cpp
 * (Rust commands `transcribe_local`, `list_local_models`, etc).
 *
 * Cleanup is NOT yet implemented locally — we delegate to the cloud
 * cleanup function for now (Phase 2: local LLM via Ollama/llama.cpp).
 */
import { invoke } from "@tauri-apps/api/core";
import { isPerfDebugEnabled } from "../preferences";
import { decodeToMonoF32_16k } from "./audioDecode";
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
  const raw =
    await invoke<Array<{ tier: WhisperTier; installed: boolean; size_bytes: number }>>(
      "list_local_models",
    );
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
  return invoke<boolean>("is_whisper_runtime_installed", {
    preference: getWhisperComputePreference(),
  });
}

export function installWhisperRuntime(): Promise<void> {
  return invoke("install_whisper_runtime", {
    preference: getWhisperComputePreference(),
  });
}

export type WhisperComputePreference = "auto" | "cuda" | "vulkan" | "cpu";
export type WhisperRuntimeVariant = "cpu" | "vulkan" | "cuda" | "metal";

// Provider selection persisted in localStorage.
const LS_AI_PROVIDER = "sw.ai.provider";
const LS_LOCAL_WHISPER_TIER = "sw.ai.localWhisperTier";
const LS_WHISPER_COMPUTE = "sw.ai.whisperCompute";

export type AiProviderKind = "cloud" | "local-whisper" | "local-parakeet";

export function getAiProviderKind(): AiProviderKind {
  const v = localStorage.getItem(LS_AI_PROVIDER);
  if (v === "local-whisper" || v === "local-parakeet") return v;
  return "cloud";
}

export function setAiProviderKind(v: AiProviderKind): void {
  localStorage.setItem(LS_AI_PROVIDER, v);
}

export function getLocalWhisperTier(): WhisperTier {
  const v = localStorage.getItem(LS_LOCAL_WHISPER_TIER);
  if (v === "tiny" || v === "base" || v === "small" || v === "turbo" || v === "large-v3") return v;
  return "turbo";
}

export function setLocalWhisperTier(v: WhisperTier): void {
  localStorage.setItem(LS_LOCAL_WHISPER_TIER, v);
}

export function getWhisperComputePreference(): WhisperComputePreference {
  const v = localStorage.getItem(LS_WHISPER_COMPUTE);
  if (v === "cuda" || v === "vulkan" || v === "cpu") return v;
  return "auto";
}

export function setWhisperComputePreference(v: WhisperComputePreference): void {
  localStorage.setItem(LS_WHISPER_COMPUTE, v);
}

export function detectWhisperComputeBackend(): Promise<WhisperRuntimeVariant> {
  return invoke<WhisperRuntimeVariant>("detect_whisper_compute_backend");
}

export function getActiveWhisperRuntimeVariant(): Promise<WhisperRuntimeVariant> {
  return invoke<WhisperRuntimeVariant>("get_active_whisper_runtime_variant", {
    preference: getWhisperComputePreference(),
  });
}

export function whisperComputePreferenceLabel(v: WhisperComputePreference): string {
  switch (v) {
    case "cuda":
      return "NVIDIA (CUDA)";
    case "vulkan":
      return "GPU (Vulkan)";
    case "cpu":
      return "CPU";
    default:
      return "Auto (recommended)";
  }
}

export function whisperRuntimeVariantLabel(v: WhisperRuntimeVariant): string {
  switch (v) {
    case "cuda":
      return "NVIDIA CUDA";
    case "vulkan":
      return "Vulkan GPU";
    case "metal":
      return "Apple Metal";
    default:
      return "CPU";
  }
}

// Decode arbitrary audio Blob → 16 kHz mono Float32 PCM.
// (moved to ./audioDecode.ts so the Parakeet provider can reuse it)

export type LocalWhisperEngine = "auto" | "server" | "cli";

const LS_WHISPER_ENGINE = "sw.ai.whisperEngine";

/**
 * Which local Whisper execution path to use:
 * - "auto" (default): warm persistent `whisper-server` when its binary is present,
 *   otherwise the `whisper-cli` one-shot path (previous behaviour).
 * - "server": always the warm server (errors if not installed).
 * - "cli": always the one-shot CLI.
 */
export function getLocalWhisperEngine(): LocalWhisperEngine {
  const v = localStorage.getItem(LS_WHISPER_ENGINE);
  return v === "server" || v === "cli" ? v : "auto";
}

export function setLocalWhisperEngine(v: LocalWhisperEngine): void {
  localStorage.setItem(LS_WHISPER_ENGINE, v);
}

/** Is the warm `whisper-server` binary available for the selected compute variant? */
export function isWhisperServerAvailable(): Promise<boolean> {
  return invoke<boolean>("is_whisper_server_available", {
    preference: getWhisperComputePreference(),
  });
}

export function ensureWhisperEngineReady(tier: WhisperTier): Promise<void> {
  return invoke("ensure_engine_ready", {
    tier,
    computePreference: getWhisperComputePreference(),
  });
}

// The probe is stable within a session per compute preference; cache it so we
// don't touch the filesystem on every utterance.
const serverAvailByPref = new Map<string, boolean>();

async function warmServerAvailable(): Promise<boolean> {
  const key = getWhisperComputePreference();
  const cached = serverAvailByPref.get(key);
  if (cached !== undefined) return cached;
  try {
    const ok = await isWhisperServerAvailable();
    serverAvailByPref.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}

/** Clear the cached availability probe (e.g. after installing/updating the runtime). */
export function resetWhisperEngineProbe(): void {
  serverAvailByPref.clear();
}

/** Resolve the Tauri command to use for the current engine setting. */
export async function resolveWhisperCommand(): Promise<
  "transcribe_local_pcm" | "transcribe_local_server_pcm"
> {
  const engine = getLocalWhisperEngine();
  if (engine === "cli") return "transcribe_local_pcm";
  if (engine === "server") return "transcribe_local_server_pcm";
  return (await warmServerAvailable()) ? "transcribe_local_server_pcm" : "transcribe_local_pcm";
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
    const totalStarted = performance.now();
    const samples = await decodeToMonoF32_16k(input.audio);
    const decodeMs = Math.round(performance.now() - totalStarted);
    const command = await resolveWhisperCommand();
    const perf = isPerfDebugEnabled();
    const pcmView = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const pcmBytes = new Uint8Array(pcmView.byteLength);
    pcmBytes.set(pcmView);
    const headers = {
      "content-type": "application/octet-stream",
      "x-verbatim-pcm-format": "f32le-16000-mono",
      "x-verbatim-tier": this.cfg.tier,
      "x-verbatim-language": input.language ?? "",
      "x-verbatim-translate": "false",
      "x-verbatim-compute-preference": getWhisperComputePreference(),
    };
    const ipcPayloadBytes = pcmBytes.byteLength;
    const invokeStarted = performance.now();
    const out = await invoke<{
      text: string;
      language_detected: string;
      duration_ms: number;
    }>(command, pcmBytes, { headers });
    const invokeMs = Math.round(performance.now() - invokeStarted);
    const totalMs = Math.round(performance.now() - totalStarted);
    if (perf) {
      console.debug(
        `[Verbatim AI][perf] local-whisper command=${command} decode_ms=${decodeMs} ipc_payload_bytes=${ipcPayloadBytes} invoke_ms=${invokeMs} total_ms=${totalMs}`,
      );
    }
    return {
      text: out.text,
      languageDetected: out.language_detected || (input.language ?? "auto"),
      durationMs: out.duration_ms || invokeMs,
    };
  }

  cleanup(input: CleanupInput): AsyncIterable<string> {
    return this.cfg.cleanupFallback.cleanup(input);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await listLocalModels();
      const runtime = await isWhisperRuntimeInstalled();
      if (!runtime) {
        return {
          ok: false,
          message: `${whisperRuntimeVariantLabel(await getActiveWhisperRuntimeVariant())} runtime is not installed.`,
        };
      }
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
