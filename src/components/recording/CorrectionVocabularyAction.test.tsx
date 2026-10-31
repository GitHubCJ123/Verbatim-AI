// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("../../lib/store/useAuth", () => ({ useAuth: { getState: () => ({ user: null }) } }));

import { CorrectionVocabularyAction } from "./CorrectionVocabularyAction";
import { useVocabulary } from "../../lib/store/useModes";

describe("correction term confirmation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    useVocabulary.setState({ terms: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(selectedText = "Kubernets", disabled = false) {
    await act(async () =>
      root.render(<CorrectionVocabularyAction selectedText={selectedText} disabled={disabled} />),
    );
  }

  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(label),
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  async function edit(term: string) {
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, term);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("requires explicit confirmation and lets the user edit a selected term", async () => {
    await render();
    expect(localStorage.getItem("sw.vocab")).toBeNull();
    await click("Add corrected term");
    expect(container.querySelector("input")?.value).toBe("Kubernets");
    expect(localStorage.getItem("sw.vocab")).toBeNull();
    await edit("Kubernetes");
    await click("Save term");
    expect(useVocabulary.getState().terms.map((term) => term.term)).toEqual(["Kubernetes"]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Saved to Vocabulary",
    );
  });

  it("cancel discards the draft without persisting or learning", async () => {
    await render();
    await click("Add corrected term");
    await edit("Never saved");
    await click("Cancel");
    expect(container.querySelector("input")).toBeNull();
    expect(localStorage.getItem("sw.vocab")).toBeNull();
    await render("");
    await click("Add corrected term");
    expect(container.querySelector("input")?.value).toBe("");
  });

  it("shows duplicate and invalid errors without claiming success", async () => {
    await useVocabulary.getState().add({ term: "Kubernetes" });
    await render("kubernetes");
    await click("Add corrected term");
    await click("Save term");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("already");
    await edit("");
    await click("Save term");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter a term");
    expect(useVocabulary.getState().terms).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps the editable draft and visibly reports persistence errors", async () => {
    await render("Kubernetes");
    await click("Add corrected term");
    const storage = localStorage;
    const setItem = vi.fn((key: string, value: string) => storage.setItem(key, value));
    setItem.mockImplementationOnce(() => {
      throw new Error("Storage is full");
    });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.getItem(key),
      setItem,
    });
    await click("Save term");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Storage is full");
    expect(container.querySelector("input")?.value).toBe("Kubernetes");
    expect(container.querySelector('[role="status"]')).toBeNull();
    await click("Save term");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
  });

  it("blocks opening during polishing and isolates Escape from Review shortcuts", async () => {
    await render("Kubernetes", true);
    await click("Add corrected term");
    expect(container.querySelector("input")).toBeNull();
    await render("Kubernetes");
    await click("Add corrected term");
    const discard = vi.fn();
    window.addEventListener("keydown", discard);
    await act(async () => {
      container
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    window.removeEventListener("keydown", discard);
    expect(discard).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(localStorage.getItem("sw.vocab")).toBeNull();
  });
});
