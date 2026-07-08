/**
 * Transcription coordinator (docs/proposals/handy-adoption.md §Phase 6,
 * issue #23 P2.6).
 *
 * Clean-room reimplementation of the *idea* behind Handy's
 * `transcription_coordinator.rs`: serialize the lifecycle of overlapping
 * partial-transcription requests so they never pile up. No Handy source
 * is copied — only the behavioural contract is reproduced.
 *
 * Contract:
 *  - **Single in-flight.** At most one `run(payload)` executes at a time.
 *  - **Debounce.** `submit` starts a short trailing debounce (default
 *    30 ms) anchored to the first pending submission; rapid submits
 *    within the window coalesce into a single launch using the latest
 *    payload (mirrors Handy's 30 ms debounce and Phase 6's "no IPC
 *    storm" acceptance).
 *  - **Drop intermediate.** A submit that arrives while a run is in
 *    flight replaces any earlier queued payload — only the newest
 *    pending payload survives; intermediate ones are dropped.
 *  - **Drain latest.** When the in-flight run settles, the newest
 *    pending payload (if any) is scheduled next.
 *  - **Dispose.** After {@link dispose}, no timer fires, no queued
 *    payload runs, and results/errors from an already in-flight run are
 *    swallowed (guards against stale partials landing after stop).
 */

export interface TranscriptionCoordinatorOptions<T, R> {
  /** The async work for one partial (e.g. transcribe the audio-so-far). */
  run: (payload: T) => Promise<R>;
  /** Called with a successful result and the payload that produced it. */
  onResult?: (result: R, payload: T) => void;
  /** Called if a run rejects. Best-effort — partials may fail silently. */
  onError?: (err: unknown, payload: T) => void;
  /** Trailing debounce window before a launch. Default 30 ms. */
  debounceMs?: number;
}

export class TranscriptionCoordinator<T, R> {
  private readonly run: (payload: T) => Promise<R>;
  private readonly onResult?: (result: R, payload: T) => void;
  private readonly onError?: (err: unknown, payload: T) => void;
  private readonly debounceMs: number;

  private pending: { payload: T } | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: TranscriptionCoordinatorOptions<T, R>) {
    this.run = opts.run;
    this.onResult = opts.onResult;
    this.onError = opts.onError;
    this.debounceMs = Math.max(0, opts.debounceMs ?? 30);
  }

  /** Queue a payload. Coalesced/dropped per the class contract. */
  submit(payload: T): void {
    if (this.disposed) return;
    this.pending = { payload };
    this.schedule();
  }

  /** True while a `run` is executing. */
  get isRunning(): boolean {
    return this.running;
  }

  /** True while a payload is queued (not yet launched). */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Stop the coordinator. Cancels any debounce timer, forgets the queued
   * payload, and ignores the result of any run already in flight.
   */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  private schedule(): void {
    // A run in flight will drain the queue itself on completion; a
    // ticking timer already owns the next launch.
    if (this.disposed || this.running || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launch();
    }, this.debounceMs);
  }

  private launch(): void {
    if (this.disposed || this.running) return;
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    this.running = true;
    Promise.resolve()
      .then(() => this.run(job.payload))
      .then(
        (result) => {
          if (!this.disposed) this.onResult?.(result, job.payload);
        },
        (err) => {
          if (!this.disposed) this.onError?.(err, job.payload);
        },
      )
      .finally(() => {
        this.running = false;
        if (!this.disposed && this.pending) this.schedule();
      });
  }
}
