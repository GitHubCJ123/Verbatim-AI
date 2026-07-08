/**
 * True token-level streaming client (issue #33,
 * docs/proposals/streaming-sidecar.md).
 *
 * Thin TS wrapper around the Rust streaming-sidecar commands. It buffers the
 * live 16 kHz mono f32 frames emitted by the AudioWorklet (`onFrame` in
 * `src/lib/audio.ts`), flushes them to the sidecar on a short cadence to avoid
 * a per-frame IPC storm, and forwards the sidecar's `stream:partial` events to
 * an `onPartial` callback — but only for the matching session (a stale-session
 * guard so partials from a superseded recording can't paint the next one).
 *
 * The whole feature is opt-in (`sw.transcribe.trueStreaming`, default off) and
 * gated on sidecar availability; the overlay falls back to the chunked path if
 * {@link StreamingTranscriber.start} rejects. This client never throws into the
 * audio callback: push failures are swallowed so a mid-stream sidecar problem
 * degrades to "no preview update" rather than breaking recording.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type StreamPartialKind = "partial" | "final";

export interface StreamPartial {
  kind: StreamPartialKind;
  text: string;
}

interface StreamPartialEvent {
  sessionId: number;
  kind: StreamPartialKind;
  text: string;
}

export interface StreamingTranscriberOptions {
  /** Whisper model tier/id passed to the sidecar. */
  tier: string;
  /** Compute-variant preference ("auto" | "cpu" | "cuda" | "vulkan"). */
  computePreference?: string;
  /** Called for every partial/final event of the current session. */
  onPartial: (partial: StreamPartial) => void;
  /** Flush cadence in ms. Default 200 ms. */
  flushIntervalMs?: number;
}

/** Is the streaming sidecar binary bundled for the active compute variant? */
export function isStreamingSidecarAvailable(preference?: string): Promise<boolean> {
  return invoke<boolean>("is_streaming_sidecar_available", { preference });
}

export class StreamingTranscriber {
  private readonly tier: string;
  private readonly computePreference?: string;
  private readonly onPartial: (partial: StreamPartial) => void;
  private readonly flushIntervalMs: number;

  private sessionId: number | null = null;
  private unlisten: UnlistenFn | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer: number[] = [];
  private disposed = false;
  private finished = false;

  constructor(opts: StreamingTranscriberOptions) {
    this.tier = opts.tier;
    this.computePreference = opts.computePreference;
    this.onPartial = opts.onPartial;
    this.flushIntervalMs = Math.max(20, opts.flushIntervalMs ?? 200);
  }

  /**
   * Start a sidecar session and begin listening for partials. Rejects if the
   * sidecar can't start so the caller can fall back to the chunked path. Any
   * events emitted before this resolves are buffered by the sessionId guard.
   */
  async start(): Promise<void> {
    // Register the listener before starting so we don't miss early partials.
    this.unlisten = await listen<StreamPartialEvent>("stream:partial", (event) => {
      const payload = event.payload;
      // Stale-session guard: ignore events from a superseded recording.
      if (this.disposed || payload.sessionId !== this.sessionId) return;
      this.onPartial({ kind: payload.kind, text: payload.text });
    });

    try {
      this.sessionId = await invoke<number>("start_streaming_session", {
        tier: this.tier,
        computePreference: this.computePreference,
      });
    } catch (err) {
      await this.dispose();
      throw err;
    }

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Feed one live frame. Buffered and flushed on the next cadence tick. Frames
   * pushed before the session id resolves are retained and flushed once the
   * session starts, so the first syllables aren't lost during async start.
   */
  push(frame: Float32Array): void {
    if (this.disposed || this.finished) return;
    for (let i = 0; i < frame.length; i++) this.buffer.push(frame[i]);
  }

  /**
   * Finalize: flush remaining frames, send the finalize marker, and stop the
   * cadence timer. The sidecar emits its `final` event via the listener. Safe
   * to call once; further pushes are ignored.
   */
  async finish(): Promise<void> {
    if (this.disposed || this.finished || this.sessionId === null) return;
    this.finished = true;
    this.stopTimer();
    await this.flush();
    const id = this.sessionId;
    try {
      await invoke("finish_streaming_session", { sessionId: id });
    } catch {
      // Best-effort: a finalize failure still lets the final path run.
    }
  }

  /**
   * Tear down: stop the timer, terminate the sidecar session, and remove the
   * event listener. Idempotent. Call on stop/cancel/unmount.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    const id = this.sessionId;
    this.sessionId = null;
    this.buffer = [];
    if (id !== null) {
      try {
        await invoke("stop_streaming_session", { sessionId: id });
      } catch {
        // ignore — process is terminating anyway
      }
    }
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.sessionId === null || this.buffer.length === 0) return;
    const frames = this.buffer;
    this.buffer = [];
    const id = this.sessionId;
    try {
      await invoke("push_streaming_frames", { sessionId: id, frames });
    } catch {
      // Swallow: never throw into the audio callback. A persistent failure
      // simply stops updating the preview; the final path is unaffected.
    }
  }
}
