/**
 * Provider-agnostic AI interface. See plan §11.
 *
 * All providers must implement this contract so we can plug different
 * vendors (Azure today, OpenAI / Anthropic / local Whisper later)
 * without touching the recording pipeline.
 */

export interface TranscribeInput {
  audio: Blob;
  /** Client-observed recording length; Edge Functions enforce a server-side cap. */
  durationMs?: number;
  /** BCP-47 code, or 'auto' to let the provider detect. */
  language?: string;
  /** Optional list of proper nouns / jargon to bias the recognizer. */
  vocabularyHints?: string[];
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResult {
  text: string;
  languageDetected: string;
  durationMs: number;
  segments?: TranscribeSegment[];
}

export interface CleanupInput {
  rawText: string;
  /** Body of the Mode's system prompt (per-mode rules). */
  systemPrompt: string;
  /** Human-readable Mode name, used inside the templated meta-prompt. */
  modeName: string;
  /** Short Mode description (also templated in). */
  modeDescription?: string;
  vocabulary?: string[];
  targetLanguage?: string;
  temperature?: number;
}

export interface ProviderHealth {
  ok: boolean;
  /** Free-form message: "Connected", "401 Unauthorized", etc. */
  message: string;
  /** Round-trip latency in ms, if measured. */
  latencyMs?: number;
}

export interface AIProvider {
  name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  /** Streams cleaned text tokens as they arrive from the provider. */
  cleanup(input: CleanupInput): AsyncIterable<string>;
  health(): Promise<ProviderHealth>;
}
