import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Onboarding from "./Onboarding";
import { useOnboarding } from "../../lib/store/useOnboarding";

vi.hoisted(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

// SSR normally reads Zustand's creation-time snapshot. Render the explicitly
// selected test step rather than that initial welcome snapshot.
vi.mock("../../lib/store/useOnboarding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/store/useOnboarding")>();
  function snapshot<T>(selector: (state: ReturnType<typeof actual.useOnboarding.getState>) => T) {
    return selector(actual.useOnboarding.getState());
  }
  return { ...actual, useOnboarding: Object.assign(snapshot, actual.useOnboarding) };
});

function renderStep(step: number, values: Record<string, string> = {}) {
  const state = new Map(Object.entries(values));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => state.get(key) ?? null,
    setItem: (key: string, value: string) => state.set(key, value),
  });
  useOnboarding.setState({ step });
  return {
    html: renderToStaticMarkup(
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>,
    ),
    state,
  };
}

afterEach(() => {
  useOnboarding.setState({ step: 0 });
  vi.unstubAllGlobals();
});

describe("Quick Start presentation", () => {
  it("does not offer unavailable cloud/account guidance", () => {
    const { html } = renderStep(0);
    expect(html).toContain("Quick start");
    expect(html).toContain("No account required");
    expect(html).not.toContain("opt into cloud");
  });

  it("resumes a legacy account step at model setup without resetting cloud values", () => {
    const { html, state } = renderStep(2, { "sw.ai.provider": "cloud" });
    expect(html).toContain("Pick your AI");
    expect(html).not.toContain("You can sign in later");
    expect(state.get("sw.ai.provider")).toBe("cloud");
  });

  it("shows setup needs and synthetic practice without claiming dictation is ready", () => {
    const { html, state } = renderStep(12);
    expect(html).toContain("Your Quick Start checklist");
    expect(html).toContain("Checking downloaded models");
    expect(html).toContain("Practice space");
    expect(html).toContain("does not save text");
    expect(html).not.toContain("You&#x27;re all set");
    expect(state.size).toBe(0);
  });

  it("uses configured toggle instructions", () => {
    const { html } = renderStep(12, { "sw.hotkey.spec": "F9", "sw.hotkey.ptt": "0" });
    expect(html).toContain("press again to finish");
    expect(html).not.toContain("release to finish");
  });

  it("keeps Fn hold-only even when the stored toggle preference is off", () => {
    const { html } = renderStep(12, { "sw.hotkey.spec": "Fn", "sw.hotkey.ptt": "0" });
    expect(html).toContain("release to finish");
    expect(html).not.toContain("press again to finish");
  });
});
