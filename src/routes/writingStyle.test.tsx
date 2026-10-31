import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { buildBuiltinModes } from "../lib/store/builtinModes";
import { TooltipProvider } from "../components/ui/Tooltip";

const state = vi.hoisted(() => ({
  modes: [] as ReturnType<typeof buildBuiltinModes>,
  defaultModeId: "",
  update: vi.fn(),
  setDefault: vi.fn(),
}));
vi.mock("../lib/store/useModes", () => ({
  useModes: (selector: (store: typeof state) => unknown) => selector(state),
  loadVocabulary: () => [],
}));
vi.mock("../lib/preferences", () => ({
  isAiImproveDisabled: () => false,
  setAiImproveDisabled: vi.fn(),
  getMicDeviceId: () => "",
}));
vi.mock("../lib/ai", () => ({
  getActiveProvider: vi.fn(),
  WHISPER_TIERS: [],
  CLEANUP_MODELS: [],
  isCleanupModelId: () => false,
}));
vi.mock("../lib/audio", () => ({ startRecording: vi.fn() }));
vi.mock("../components/settings/HotkeyRecorder", () => ({
  HotkeyRecorder: ({ value }: { value: string }) => (
    <input aria-label="Mode hotkey" value={value} readOnly />
  ),
}));
vi.mock("./Apps", () => ({ AppsPanel: () => <div>App mappings</div> }));

import Modes from "./Modes";
import ModeEditor from "./ModeEditor";

describe("Simple and advanced mode surfaces", () => {
  state.modes = buildBuiltinModes();
  state.defaultModeId = state.modes[0].id;

  it("foregrounds style selection and leaves all recipe management inside a closed disclosure", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TooltipProvider>
          <Modes />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(html.indexOf("<select")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain("Advanced: Mode recipes");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toMatch(/<details[\s\S]*New Mode[\s\S]*<\/details>/);
    expect(html).toContain("Duplicate");
    expect(html).toContain("Drag handle");
    expect(html).toContain(">Apps<");
    expect(state.setDefault).not.toHaveBeenCalled();
  });

  it("preserves advanced custom fields on initial render without saving or starting a recording", () => {
    const mode = state.modes[0];
    mode.hotkey = "Control+Shift+J";
    mode.targetLanguage = "French";
    mode.cleanupProviderOverride = "local";
    mode.cleanupModelOverride = "legacy-custom-model";
    const before = JSON.stringify(mode);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/modes/editor?id=${mode.id}`]}>
        <ModeEditor />
      </MemoryRouter>,
    );
    expect(html).toContain("Advanced recipe settings");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toMatch(/<details[\s\S]*System prompt[\s\S]*<\/details>/);
    expect(html).toContain("French");
    expect(html).toContain("Control+Shift+J");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Try this recipe with a recording");
    expect(html).toContain("Save to history");
    expect(JSON.stringify(mode)).toBe(before);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("retains the Apps deep link", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/modes?tab=apps"]}>
        <TooltipProvider>
          <Modes />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("App mappings");
    expect(html).not.toContain("<select");
  });
});
