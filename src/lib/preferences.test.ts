import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// preferences.ts imports the tauri autostart plugin at module load; stub it so
// the module can be imported in a plain node test environment.
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn(() => Promise.resolve(false)),
  enable: vi.fn(() => Promise.resolve()),
  disable: vi.fn(() => Promise.resolve()),
}));

import {
  isTrueStreamingEnabled,
  setTrueStreamingEnabled,
  isLivePartialEnabled,
} from "./preferences";

describe("true-streaming preference", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults OFF when the key is unset (non-breaking guarantee)", () => {
    expect(isTrueStreamingEnabled()).toBe(false);
    // The pre-existing chunked live-partial preview is likewise off by default.
    expect(isLivePartialEnabled()).toBe(false);
  });

  it("round-trips the opt-in flag", () => {
    setTrueStreamingEnabled(true);
    expect(isTrueStreamingEnabled()).toBe(true);
    setTrueStreamingEnabled(false);
    expect(isTrueStreamingEnabled()).toBe(false);
  });

  it("uses a distinct storage key from the chunked live-partial flag", () => {
    setTrueStreamingEnabled(true);
    // Enabling true streaming must not implicitly enable the chunked path.
    expect(isLivePartialEnabled()).toBe(false);
  });
});
