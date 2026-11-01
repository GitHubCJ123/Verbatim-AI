// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { entryHref, searchSettings } from "../lib/settingsRegistry";
import Settings from "./Settings";

function renderSettings(path: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Settings />
    </MemoryRouter>,
  );
}

describe("diagnostics settings navigation", () => {
  beforeEach(() => localStorage.clear());

  it("places local diagnostics under Privacy and exposes its palette deep link", () => {
    const html = renderSettings("/settings?tab=privacy");
    expect(html).toContain('id="setting-diagnostics"');
    expect(html).toContain('aria-label="Store local diagnostics"');
    expect(html).toContain("nothing is uploaded.");
    expect(html).not.toContain("Anonymous telemetry");
    const entry = searchSettings("local diagnostics")[0];
    expect(entryHref(entry)).toBe("/settings?tab=privacy&highlight=diagnostics");
  });

  it("does not advertise a nonfunctional log-level control", () => {
    const html = renderSettings("/settings?tab=advanced");
    expect(html).not.toContain("Log level");
    expect(searchSettings("log level").some((entry) => entry.id === "log-level")).toBe(false);
  });
});
