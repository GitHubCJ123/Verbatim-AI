/**
 * Built-in cleanup ("AI polish"): a curated list of small local models run
 * by the app's resident llama.cpp server (src-tauri/src/commands/llama_cpp.rs).
 */
import { invoke } from "@tauri-apps/api/core";
import { CLOUD_FEATURES_ENABLED } from "../features";
import type { Cleaner, CleanupInput, ProviderHealth } from "./AIProvider";
import { buildCleanupMessages, cleanupTokenBudget } from "./promptBuilder";

const LS_CLEANUP_PROVIDER = "sw.ai.cleanupProvider";
const LS_CLEANUP_MODEL = "sw.ai.cleanupModel";

export type CleanupProviderKind = "cloud" | "local";

export type CleanupModelId = "qwen3.5-0.8b" | "qwen3.5-2b" | "qwen3-4b-2507" | "qwen3.5-4b";

export interface CleanupModelInfo {
  id: CleanupModelId;
  name: string;
  tagline: string;
  sizeMB: number;
  recommended?: boolean;
  /** 0–10. Share of the synthetic cleanup checks passed. */
  quality: number;
  /** 0–10. Generation speed relative to the fastest model. */
  speed: number;
  checksPassed: number;
  checksTotal: number;
  tokensPerSecond: number;
  shortSentenceMs: number;
  paragraphSeconds: number;
}

/**
 * Scores from src/lib/ai/localCleanup.engine.test.ts (18 light-cleanup checks
 * plus a bullet list and an email sign-off) on an Apple M1 Pro (Metal).
 * Speed is the 75-word paragraph time relative to the fastest model.
 */
export const CLEANUP_MODELS: CleanupModelInfo[] = [
  {
    id: "qwen3.5-0.8b",
    name: "Qwen3.5 0.8B",
    tagline:
      "Fastest and smallest. Can miss name corrections and sometimes answers a dictated question.",
    sizeMB: 533,
    quality: 8.0,
    speed: 10,
    checksPassed: 16,
    checksTotal: 20,
    tokensPerSecond: 122,
    shortSentenceMs: 138,
    paragraphSeconds: 0.7,
  },
  {
    id: "qwen3.5-2b",
    name: "Qwen3.5 2B",
    tagline:
      "Fast and accurate for everyday dictation in any language. Emails may skip the sign-off.",
    sizeMB: 1281,
    recommended: true,
    quality: 9.5,
    speed: 6.0,
    checksPassed: 19,
    checksTotal: 20,
    tokensPerSecond: 74,
    shortSentenceMs: 217,
    paragraphSeconds: 1.2,
  },
  {
    id: "qwen3-4b-2507",
    name: "Qwen3 4B",
    tagline: "Passes every check, including full emails. About 1.7× slower than Qwen3.5 2B.",
    sizeMB: 2497,
    quality: 10,
    speed: 3.4,
    checksPassed: 20,
    checksTotal: 20,
    tokensPerSecond: 43,
    shortSentenceMs: 358,
    paragraphSeconds: 2.1,
  },
  {
    id: "qwen3.5-4b",
    name: "Qwen3.5 4B",
    tagline: "Also passes every check; the slowest and largest option.",
    sizeMB: 2741,
    quality: 10,
    speed: 2.7,
    checksPassed: 20,
    checksTotal: 20,
    tokensPerSecond: 35,
    shortSentenceMs: 486,
    paragraphSeconds: 2.7,
  },
];

export const DEFAULT_CLEANUP_MODEL: CleanupModelId = "qwen3.5-2b";

export function isCleanupModelId(v: unknown): v is CleanupModelId {
  return CLEANUP_MODELS.some((m) => m.id === v);
}

export function cleanupModelInfo(id: CleanupModelId): CleanupModelInfo {
  return CLEANUP_MODELS.find((m) => m.id === id) ?? CLEANUP_MODELS[1];
}

export function getCleanupModel(): CleanupModelId {
  const v = localStorage.getItem(LS_CLEANUP_MODEL);
  return isCleanupModelId(v) ? v : DEFAULT_CLEANUP_MODEL;
}

export function setCleanupModel(id: CleanupModelId): void {
  localStorage.setItem(LS_CLEANUP_MODEL, id);
}

/**
 * Stored values from older versions ("local-ollama", "local-llama-cpp") all
 * resolve to the built-in engine; the stored value itself is left untouched.
 */
export function normalizeCleanupKind(v: string | null | undefined): CleanupProviderKind | null {
  if (v === "cloud") return "cloud";
  if (v === "local" || v === "local-ollama" || v === "local-llama-cpp") return "local";
  return null;
}

export function getCleanupProviderKind(): CleanupProviderKind {
  const v = normalizeCleanupKind(localStorage.getItem(LS_CLEANUP_PROVIDER));
  if (v === "cloud" && CLOUD_FEATURES_ENABLED) return "cloud";
  if (v === "local") return "local";
  return CLOUD_FEATURES_ENABLED ? "cloud" : "local";
}

export function setCleanupProviderKind(v: CleanupProviderKind): void {
  // Never persist a cloud selection while cloud is disabled; keep any
  // existing stored value intact (non-destructive no-op).
  if (v === "cloud" && !CLOUD_FEATURES_ENABLED) return;
  localStorage.setItem(LS_CLEANUP_PROVIDER, v);
}

/** Coerces "cloud" to the local engine while cloud features are disabled. */
export function effectiveCleanupKind(
  kind: CleanupProviderKind | string | null,
): CleanupProviderKind {
  const k = normalizeCleanupKind(kind) ?? getCleanupProviderKind();
  return !CLOUD_FEATURES_ENABLED && k === "cloud" ? "local" : k;
}

export interface CleanupEngineStatus {
  runtimeInstalled: boolean;
  models: { id: CleanupModelId; installed: boolean; sizeBytes: number }[];
}

export function getCleanupEngineStatus(): Promise<CleanupEngineStatus> {
  return invoke<CleanupEngineStatus>("cleanup_engine_status");
}

export function downloadCleanupModel(id: CleanupModelId): Promise<void> {
  return invoke("download_cleanup_model", { id });
}

export function deleteCleanupModel(id: CleanupModelId): Promise<void> {
  return invoke("delete_cleanup_model", { id });
}

export function ensureCleanupReady(id: CleanupModelId): Promise<void> {
  return invoke("ensure_cleanup_ready", { id });
}

export interface CleanupDownloadProgress {
  id: CleanupModelId;
  stage: "runtime" | "model";
  downloaded: number;
  total: number;
}

export class LocalCleanupProvider implements Cleaner {
  readonly name: string;

  constructor(private model: CleanupModelId) {
    this.name = cleanupModelInfo(model).name;
  }

  async *cleanup(input: CleanupInput): AsyncIterable<string> {
    yield await invoke<string>("cleanup_text", {
      args: {
        model: this.model,
        messages: buildCleanupMessages(input),
        maxTokens: cleanupTokenBudget(input),
        // Minimal edits should be deterministic; restyles benefit from a little variety.
        temperature: input.temperature ?? (input.lightCleanup ? 0 : 0.2),
      },
    });
  }

  async health(): Promise<ProviderHealth> {
    try {
      const status = await getCleanupEngineStatus();
      const installed = status.models.find((m) => m.id === this.model)?.installed;
      if (!status.runtimeInstalled || !installed) {
        return { ok: false, message: `${this.name} isn't downloaded yet.` };
      }
      const start = performance.now();
      await ensureCleanupReady(this.model);
      return {
        ok: true,
        message: `${this.name} ready`,
        latencyMs: Math.round(performance.now() - start),
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
