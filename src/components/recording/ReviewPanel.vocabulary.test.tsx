// @vitest-environment happy-dom
import { act, type HTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("../../lib/store/useAuth", () => ({ useAuth: { getState: () => ({ user: null }) } }));
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, className }: HTMLAttributes<HTMLDivElement>) => (
      <div className={className}>{children}</div>
    ),
  },
}));

import { ReviewPanel } from "./ReviewPanel";
import { useVocabulary } from "../../lib/store/useModes";

describe("Review correction vocabulary integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onPaste = vi.fn();
  const onDiscard = vi.fn();
  const text = "Send the synthetic schedule to Kubernetes.";

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    useVocabulary.setState({ terms: [] });
    onPaste.mockReset();
    onDiscard.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <ReviewPanel
          modeName="Synthetic mode"
          initialText={text}
          isPolishing={false}
          onPaste={onPaste}
          onCopy={vi.fn()}
          onDiscard={onDiscard}
          onRegenerate={vi.fn()}
        />,
      ),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === label,
    )!;
    await act(async () => button.click());
  }

  it("opens a blank term without copying the entire dictation", async () => {
    await click("Add corrected term");
    expect(container.querySelector("input")?.value).toBe("");
    expect(localStorage.getItem("sw.vocab")).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe(text);
  });

  it("suggests only the explicit selection and leaves dictation intact after saving", async () => {
    const textarea = container.querySelector("textarea")!;
    const start = text.indexOf("Kubernetes");
    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(start, start + "Kubernetes".length);
      textarea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await click("Add corrected term");
    expect(container.querySelector("input")?.value).toBe("Kubernetes");
    await click("Save term");
    expect(useVocabulary.getState().terms.map((term) => term.term)).toEqual(["Kubernetes"]);
    expect(textarea.value).toBe(text);
    expect(JSON.stringify(useVocabulary.getState().terms)).not.toContain("synthetic schedule");
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("Escape and command-Enter inside confirmation do not discard or paste Review", async () => {
    await click("Add corrected term");
    await act(async () => {
      container
        .querySelector("input")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
        );
    });
    expect(onPaste).not.toHaveBeenCalled();
    await act(async () => {
      container
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDiscard).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe(text);
  });
});
