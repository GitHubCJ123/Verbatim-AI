/**
 * Speech-model selection (issue #34).
 *
 * Resolves which {@link FrameVad} the VAD consumers use: the Silero-ONNX
 * model when it is enabled and loads successfully, otherwise `undefined`
 * so {@link SmoothedVad} keeps its built-in energy VAD. Every failure
 * path falls back to the energy VAD so nothing breaks if the runtime or
 * model asset is unavailable at runtime.
 *
 * The ONNX runtime is loaded lazily via a dynamic import so it — and the
 * bundled model — are never pulled into non-browser code paths.
 */
import type { FrameVad } from "./vad";
import { SileroVad, precomputeVad, type SileroSession } from "./silero";
import { isSileroVadEnabled } from "../preferences";

let sessionPromise: Promise<SileroSession | null> | null = null;
let readySession: SileroSession | null = null;

/**
 * Load (once) and cache the shared Silero session. Returns `null` when
 * Silero is disabled or the model/runtime can't be loaded. The cached
 * promise is cleared on failure so a later attempt can retry.
 */
function getSharedSession(): Promise<SileroSession | null> {
  if (!isSileroVadEnabled()) return Promise.resolve(null);
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const { loadSileroSession } = await import("./sileroLoader");
        return await loadSileroSession();
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[Verbatim AI] Silero VAD unavailable:", e);
        return null;
      }
    })().then(
      (s) => {
        if (!s) sessionPromise = null;
        readySession = s;
        return s;
      },
      () => {
        sessionPromise = null;
        readySession = null;
        return null;
      },
    );
  }
  return sessionPromise;
}

/**
 * Warm the Silero session ahead of the first recording so the realtime
 * path never blocks on a cold load. Safe to call repeatedly; a no-op
 * when Silero is disabled.
 */
export function warmupSpeechModel(): void {
  void getSharedSession();
}

/**
 * Frame classifier for the **realtime** frame path (auto-stop). Returns
 * a fresh {@link SileroVad} when available, else `undefined` (energy VAD).
 */
export async function getRealtimeSpeechModel(): Promise<FrameVad | undefined> {
  const session = await getSharedSession();
  return session ? new SileroVad(session) : undefined;
}

/**
 * Non-blocking variant for latency-critical realtime start: returns a
 * {@link SileroVad} **only if** the Silero session is already loaded,
 * otherwise `undefined` (energy VAD for this recording) while kicking off
 * a warmup so a later recording upgrades. Never blocks mic capture on a
 * cold model load.
 */
export function getReadyRealtimeSpeechModel(): FrameVad | undefined {
  if (readySession) return new SileroVad(readySession);
  warmupSpeechModel();
  return undefined;
}

/**
 * Frame classifier for the **post-hoc** silence-trim path. Precomputes
 * Silero probabilities over the whole 16 kHz buffer and returns a
 * synchronous replay model, or `undefined` (energy VAD) on any failure.
 */
export async function getTrimSpeechModel(pcm: Float32Array): Promise<FrameVad | undefined> {
  const session = await getSharedSession();
  if (!session) return undefined;
  try {
    return await precomputeVad(pcm, new SileroVad(session));
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Verbatim AI] Silero trim precompute failed:", e);
    return undefined;
  }
}
