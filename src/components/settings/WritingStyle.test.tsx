import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WritingStyle } from "./WritingStyle";
import { buildBuiltinModes } from "../../lib/store/builtinModes";

describe("Writing Style presentation", () => {
  const modes = buildBuiltinModes();
  const custom = {
    ...modes[0],
    id: "custom-recipe",
    name: "Custom recipe",
    description: "Synthetic custom configuration",
    isBuiltin: false,
    systemPrompt: "Keep synthetic text concise.",
    targetLanguage: "French",
    hotkey: "Control+Shift+J",
    outputStyle: "review" as const,
    cleanupProviderOverride: "local" as const,
    cleanupModelOverride: "custom-stored-model",
    transcribeProviderOverride: "cloud" as const,
    skipCleanup: true,
  };

  it("offers every stored mode and retains the selected custom recipe without normalizing it", () => {
    const stored = [...modes, custom];
    const before = JSON.stringify(stored);
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(
      <WritingStyle
        modes={stored}
        defaultModeId={custom.id}
        onSelect={onSelect}
        onEdit={vi.fn()}
      />,
    );
    expect(html.match(/<option /g)).toHaveLength(stored.length);
    expect(html).toContain('value="custom-recipe" selected=""');
    expect(html).toContain(custom.description);
    expect(html).toContain("This mode skips AI cleanup.");
    expect(html).toContain("This mode opens Review before pasting.");
    expect(html).toContain("App-specific modes still take priority.");
    expect(JSON.stringify(stored)).toBe(before);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("matches the existing first-mode fallback without writing a new default", () => {
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(
      <WritingStyle modes={modes} defaultModeId="missing" onSelect={onSelect} onEdit={vi.fn()} />,
    );
    expect(html).toContain(`value="${modes[0].id}" selected=""`);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("has a labelled, disabled empty selector and no customize action before hydration", () => {
    const html = renderToStaticMarkup(
      <WritingStyle modes={[]} defaultModeId={null} onSelect={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(html).toContain("No styles yet");
    expect(html).toContain('disabled=""');
    expect(html).toContain("aria-describedby=");
    expect(html).toContain("for=");
    expect(html).not.toContain("Customize");
  });
});
