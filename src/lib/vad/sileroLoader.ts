/**
 * Runtime loader for the Silero VAD ONNX model (issue #34).
 *
 * This is the *only* module that imports `onnxruntime-web` and the
 * bundled `.onnx` asset. It is imported dynamically (see
 * `speechModel.ts`) so the WASM runtime is pulled in lazily, only when
 * Silero VAD is actually used in the browser, and never during unit
 * tests (which exercise the pure adapter in `silero.ts` with a mock).
 *
 * Model: Silero VAD v5 (`silero_vad.onnx`), MIT-licensed
 * (github.com/snakers4/silero-vad, © Silero Team). I/O contract,
 * verified against the bundled file:
 *   input  "input"  float32 [1, 512]
 *   input  "state"  float32 [2, 1, 128]   (LSTM state, zeros at reset)
 *   input  "sr"     int64   scalar         (16000)
 *   output "output" float32 [1, 1]         (speech probability)
 *   output "stateN" float32 [2, 1, 128]    (next LSTM state)
 */
import * as ort from "onnxruntime-web/wasm";
import modelUrl from "../../assets/vad/silero_vad.onnx?url";
import {
  SILERO_STATE_SIZE,
  type SileroInferResult,
  type SileroSession,
} from "./silero";

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getInferenceSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    // Single-threaded WASM keeps the loader portable (no cross-origin
    // isolation / SharedArrayBuffer requirement) inside the Tauri webview.
    ort.env.wasm.numThreads = 1;
    sessionPromise = ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
    }).catch((e) => {
      // Don't cache a transient load failure — allow a later retry.
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

/**
 * Load the Silero model and return a {@link SileroSession}. Rejects if
 * the runtime or model asset can't be loaded; callers fall back to the
 * energy VAD.
 */
export async function loadSileroSession(): Promise<SileroSession> {
  const session = await getInferenceSession();

  const infer = async (
    window: Float32Array,
    state: Float32Array,
    sampleRate: number,
  ): Promise<SileroInferResult> => {
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor("float32", window, [1, window.length]),
      state: new ort.Tensor("float32", state, [2, 1, 128]),
      sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(sampleRate)]), []),
    };
    const out = await session.run(feeds);
    const probability = (out.output.data as Float32Array)[0] ?? 0;
    const nextState = out.stateN.data as Float32Array;
    return {
      probability,
      state:
        nextState.length === SILERO_STATE_SIZE ? nextState : new Float32Array(SILERO_STATE_SIZE),
    };
  };

  return { infer };
}
