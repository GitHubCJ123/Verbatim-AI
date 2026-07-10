/**
 * Local cleanup provider backed by llama.cpp.
 *
 * llama.cpp is a local LLM runtime, so it belongs to the cleanup/polish half
 * of the pipeline. It is not used for transcription; whisper.cpp remains the
 * ggml speech-to-text runtime.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Cleaner,
  CleanupInput,
  ProviderHealth,
} from "./AIProvider";
import { buildCleanupPrompt } from "./promptBuilder";

const LS_LLAMA_CPP_MODEL = "sw.ai.llamaCppModel";

export interface LlamaCppModelSuggestion {
  id: string;
  label: string;
  approxDiskMB: number;
  blurb: string;
  recommended?: boolean;
}

export const LLAMA_CPP_MODELS: LlamaCppModelSuggestion[] = [
  {
    id: "ggml-org/gemma-3-1b-it-GGUF",
    label: "Gemma 3 — 1B",
    approxDiskMB: 900,
    blurb: "Tiny starter model from the llama.cpp docs. Fast, useful for smoke tests.",
    recommended: true,
  },
  {
    id: "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M",
    label: "Llama 3.2 — 3B Q4",
    approxDiskMB: 2200,
    blurb: "Small Meta instruct model. Better cleanup quality than 1B on modern laptops.",
  },
  {
    id: "bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
    label: "Qwen 2.5 — 7B Q4",
    approxDiskMB: 4700,
    blurb: "Stronger local cleanup if you have enough memory. Good balance of quality and size.",
  },
];

export function getLlamaCppModel(): string {
  return localStorage.getItem(LS_LLAMA_CPP_MODEL) || LLAMA_CPP_MODELS[0].id;
}

export function setLlamaCppModel(v: string): void {
  localStorage.setItem(LS_LLAMA_CPP_MODEL, v);
}

export function isLlamaCppRuntimeInstalled(): Promise<boolean> {
  return invoke<boolean>("is_llama_cpp_runtime_installed");
}

export function installLlamaCppRuntime(): Promise<void> {
  return invoke("install_llama_cpp_runtime");
}

export interface LlamaCppConfig {
  model: string;
}

export class LlamaCppProvider implements Cleaner {
  readonly name: string;

  constructor(private cfg: LlamaCppConfig) {
    this.name = `llama.cpp (${cfg.model || "no model"})`;
  }

  async *cleanup(input: CleanupInput): AsyncIterable<string> {
    if (!this.cfg.model) {
      throw new Error("No llama.cpp model selected. Pick one in Settings -> AI model.");
    }
    const { system, user } = buildCleanupPrompt(input);
    const output = await invoke<string>("cleanup_llama_cpp", {
      args: {
        model: this.cfg.model,
        prompt: `${system}\n\n${user}`,
        temperature: input.temperature ?? 0.3,
        maxTokens: 768,
      },
    });
    yield output;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const installed = await isLlamaCppRuntimeInstalled();
      if (!installed) {
        return { ok: false, message: "llama.cpp runtime is not installed." };
      }
      if (!this.cfg.model) {
        return { ok: false, message: "No llama.cpp model selected." };
      }
      return { ok: true, message: `llama.cpp ready (${this.cfg.model})` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
