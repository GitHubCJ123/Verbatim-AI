import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBuiltinModes } from "../lib/store/builtinModes";
import { entryHref, searchSettings, SETTINGS_ENTRIES } from "../lib/settingsRegistry";

const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  modes: [] as ReturnType<typeof buildBuiltinModes>,
  defaultModeId: "",
}));

vi.hoisted(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => state.values.get(key) ?? null,
    setItem: (key: string, value: string) => state.values.set(key, value),
  });
});

vi.mock("../lib/store/useModes", () => ({
  useModes: (selector: (store: typeof state) => unknown) => selector(state),
}));
vi.mock("../lib/store/useAuth", () => ({
  useAuth: (selector: (store: { user: null }) => unknown) => selector({ user: null }),
}));
vi.mock("../lib/store/useProfile", () => ({
  useProfile: (selector: (store: { profile: null }) => unknown) => selector({ profile: null }),
  initials: () => "AI",
}));
vi.mock("../lib/theme", () => ({
  useTheme: (selector: (store: { theme: string; set: () => void }) => unknown) =>
    selector({ theme: "dark", set: vi.fn() }),
}));
vi.mock("../lib/recording-bridge", () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  cancelRecording: vi.fn(),
}));
vi.mock("../lib/history", () => ({ listTranscriptions: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../lib/ai", async () => {
  const speech = await import("../lib/ai/localWhisper");
  const cleanup = await import("../lib/ai/localCleanup");
  return {
    getAiProviderKind: speech.getAiProviderKind,
    effectiveTranscribeKind: speech.effectiveTranscribeKind,
    getCleanupProviderKind: cleanup.getCleanupProviderKind,
    effectiveCleanupKind: cleanup.effectiveCleanupKind,
    prewarmEngines: vi.fn(),
  };
});
vi.mock("../components/feedback/FeedbackDialog", () => ({ FeedbackDialog: () => null }));

import Home from "./Home";
import { Sidebar } from "../components/layout/Sidebar";
import { TopBar } from "../components/layout/TopBar";

function renderHome() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.values.clear();
  state.modes = buildBuiltinModes();
  state.defaultModeId = state.modes[0].id;
});

describe("Home dictation guidance", () => {
  it("describes hold-to-talk using the saved shortcut", () => {
    state.values.set("sw.hotkey.spec", "F9");
    state.values.set("sw.hotkey.ptt", "1");
    const html = renderHome();
    expect(html).toContain("Hold to dictate");
    expect(html).toContain("Press and hold");
    expect(html).toContain(">F9<");
    expect(html).toContain("Release to transcribe.");
    expect(html).not.toContain("Press again to transcribe.");
  });

  it("describes toggle without telling the user to release to finish", () => {
    state.values.set("sw.hotkey.spec", "Control+Shift+Space");
    state.values.set("sw.hotkey.ptt", "0");
    const html = renderHome();
    expect(html).toContain("Tap to dictate");
    expect(html).toContain("Press again to transcribe.");
    expect(html).not.toContain("Press and hold");
    expect(html).not.toContain("Release to transcribe.");
  });

  it.each(["Fn", "RightCommand"])("keeps %s hold-only with toggle stored", (spec) => {
    state.values.set("sw.hotkey.spec", spec);
    state.values.set("sw.hotkey.ptt", "0");
    expect(renderHome()).toContain("Release to transcribe.");
    expect(renderHome()).not.toContain("Tap to dictate");
  });
});

describe("Home local-only privacy copy", () => {
  it("resolves old cloud selections without advertising cloud or modifying them", () => {
    state.values.set("sw.ai.provider", "cloud");
    state.values.set("sw.ai.cleanupProvider", "cloud");
    state.modes[0].transcribeProviderOverride = "cloud";
    state.modes[0].cleanupProviderOverride = "cloud";
    const before = JSON.stringify(state.modes);
    const html = renderHome();
    expect(html).toContain("Dictation is processed on this machine");
    expect(html).toContain("Model downloads and app updates use the network.");
    expect(html).toContain("For your default writing style");
    expect(html).not.toMatch(/account sync|Verbatim cloud|Azure|partly cloud/i);
    expect(state.values.get("sw.ai.provider")).toBe("cloud");
    expect(state.values.get("sw.ai.cleanupProvider")).toBe("cloud");
    expect(JSON.stringify(state.modes)).toBe(before);
  });

  it("does not claim AI polish runs when the default recipe skips cleanup", () => {
    state.modes[0].skipCleanup = true;
    const html = renderHome();
    expect(html).toContain("AI polish is off.");
    expect(html).not.toContain("AI polish both run");
  });

  it("respects the global AI polish off preference", () => {
    state.values.set("sw.ai.disabled", "1");
    expect(renderHome()).toContain("AI polish is off.");
  });
});

describe("Writing Style navigation", () => {
  it("uses the same page name in the sidebar and top bar, with the stable route", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/modes"]}>
        <Sidebar />
        <TopBar />
      </MemoryRouter>,
    );
    expect(html.match(/Writing Style/g)).toHaveLength(2);
    expect(html).toMatch(/href="\/modes"[^>]*>[\s\S]*?Writing Style/);
    expect(html).not.toContain(">Modes<");
    expect(html).not.toContain(">Account<");
  });

  it("finds Writing Style by the current and legacy names without changing deep links", () => {
    const entry = searchSettings("writing style")[0];
    expect(entry.title).toBe("Writing Style");
    expect(entry.id).toBe("page-modes");
    expect(entryHref(entry)).toBe("/modes");
    expect(searchSettings("modes")).toContain(entry);
    const apps = SETTINGS_ENTRIES.find((e) => e.id === "page-apps")!;
    expect(apps.description).toContain("Writing Style");
    expect(apps.description).toContain("Mode recipes");
    expect(entryHref(apps)).toBe("/modes?tab=apps");
  });

  it("does not offer disabled cloud, Azure or account destinations in search", () => {
    expect(searchSettings("cloud")).toEqual([]);
    expect(searchSettings("azure")).toEqual([]);
    expect(searchSettings("account")).toEqual([]);
    expect(searchSettings("hotkey")[0].description).not.toContain("hold");
  });
});
