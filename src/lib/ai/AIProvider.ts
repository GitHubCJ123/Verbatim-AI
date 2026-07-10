/**
 * Provider-agnostic AI interfaces.
 *
 * Leaf providers can implement only the pipeline half they own
 * (transcription or cleanup). getActiveProvider composes one of each into
 * the legacy AIProvider shape used by the recording pipeline.
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

export interface Transcriber {
  name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  health(): Promise<ProviderHealth>;
}

export interface Cleaner {
  name: string;
  /** Streams cleaned text tokens as they arrive from the provider. */
  cleanup(input: CleanupInput): AsyncIterable<string>;
  health(): Promise<ProviderHealth>;
}

export interface AIProvider extends Transcriber, Cleaner {}
