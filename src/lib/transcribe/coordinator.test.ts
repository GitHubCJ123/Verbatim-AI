import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionCoordinator } from "./coordinator";

/** A manually-resolvable promise for controlling run() timing in tests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TranscriptionCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces rapid submits into a single launch with the latest payload", async () => {
    const seen: string[] = [];
    const c = new TranscriptionCoordinator<string, void>({
      debounceMs: 30,
      run: async (p) => {
        seen.push(p);
      },
    });
    c.submit("a");
    c.submit("b");
    c.submit("c");
    // Nothing runs before the debounce window elapses.
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(seen).toEqual(["c"]);
  });

  it("keeps a single run in flight and drops intermediate submits", async () => {
    const runs: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const gate = deferred<void>();
    const c = new TranscriptionCoordinator<string, void>({
      debounceMs: 10,
      run: async (p) => {
        runs.push(p);
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        if (p === "first") await gate.promise;
        inFlight--;
      },
    });

    c.submit("first");
    await vi.advanceTimersByTimeAsync(10);
    expect(c.isRunning).toBe(true);
    expect(runs).toEqual(["first"]);

    // While "first" is in flight, these queue; only the latest survives.
    c.submit("dropped");
    c.submit("latest");
    expect(runs).toEqual(["first"]);

    // Let "first" finish → the newest pending ("latest") drains next.
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toEqual(["first", "latest"]);
    expect(maxConcurrent).toBe(1);
  });

  it("delivers results via onResult with the originating payload", async () => {
    const results: Array<[string, number]> = [];
    const c = new TranscriptionCoordinator<string, number>({
      debounceMs: 0,
      run: async (p) => p.length,
      onResult: (r, p) => results.push([p, r]),
    });
    c.submit("hello");
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([["hello", 5]]);
  });

  it("routes rejections to onError and stays usable", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const c = new TranscriptionCoordinator<string, void>({
      debounceMs: 0,
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
      onError: (e) => errors.push(e),
    });
    c.submit("x");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    // A later submit still runs after the earlier failure.
    c.submit("y");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
  });

  it("ignores a late result and drops the queue after dispose", async () => {
    const seen: string[] = [];
    const gate = deferred<void>();
    const c = new TranscriptionCoordinator<string, string>({
      debounceMs: 0,
      run: async (p) => {
        await gate.promise;
        return p;
      },
      onResult: (r) => seen.push(r),
    });
    c.submit("inflight");
    await vi.advanceTimersByTimeAsync(0);
    expect(c.isRunning).toBe(true);

    // A queued payload plus dispose while the run is still pending.
    c.submit("queued");
    c.dispose();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(50);

    // Neither the in-flight result nor the queued payload surface.
    expect(seen).toEqual([]);
    expect(c.hasPending).toBe(false);
  });

  it("does not schedule anything when submit happens after dispose", async () => {
    let calls = 0;
    const c = new TranscriptionCoordinator<string, void>({
      debounceMs: 0,
      run: async () => {
        calls++;
      },
    });
    c.dispose();
    c.submit("nope");
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(0);
  });
});
