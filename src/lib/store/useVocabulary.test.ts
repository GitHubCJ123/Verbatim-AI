// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("./useAuth", () => ({ useAuth: { getState: () => ({ user: null }) } }));

import { useVocabulary } from "./useModes";
import { supabase } from "../supabase";

describe("explicit vocabulary persistence", () => {
  let storage: Map<string, string>;
  const setItem = vi.fn();

  beforeEach(() => {
    storage = new Map();
    setItem.mockReset();
    setItem.mockImplementation((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem,
      removeItem: (key: string) => storage.delete(key),
    });
    useVocabulary.setState({ terms: [], loading: false });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stores only the confirmed trimmed term in the existing schema", async () => {
    const term = await useVocabulary.getState().add({ term: "  Kubernetes  " });
    expect(term.term).toBe("Kubernetes");
    expect(term.notes).toBeNull();
    expect(term.replacement).toBeNull();
    expect(JSON.parse(storage.get("sw.vocab")!)).toEqual([term]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects duplicates without changing existing spelling or replacement", async () => {
    const existing = await useVocabulary.getState().add({ term: "Kubernetes", replacement: "K8s" });
    await expect(useVocabulary.getState().add({ term: " kubernetes " })).rejects.toThrow("already");
    expect(useVocabulary.getState().terms).toEqual([existing]);
  });

  it.each(["", " ", "first\nsecond", "bad\u0000term", "x".repeat(201)])(
    "rejects invalid terms before writing: %j",
    async (term) => {
      await expect(useVocabulary.getState().add({ term })).rejects.toThrow();
      expect(setItem).not.toHaveBeenCalled();
      expect(useVocabulary.getState().terms).toEqual([]);
    },
  );

  it("keeps the store unchanged when persistence fails, allowing retry", async () => {
    setItem.mockImplementationOnce(() => {
      throw new Error("Storage is full");
    });
    await expect(useVocabulary.getState().add({ term: "Kubernetes" })).rejects.toThrow(
      "Storage is full",
    );
    expect(useVocabulary.getState().terms).toEqual([]);
    expect(storage.has("sw.vocab")).toBe(false);
    await useVocabulary.getState().add({ term: "Kubernetes" });
    expect(useVocabulary.getState().terms).toHaveLength(1);
  });

  it("reads the latest cache across WebViews instead of overwriting stale terms", async () => {
    const existing = await useVocabulary.getState().add({ term: "Kubernetes" });
    useVocabulary.setState({ terms: [] });
    await expect(useVocabulary.getState().add({ term: "KUBERNETES" })).rejects.toThrow("already");
    await useVocabulary.getState().add({ term: "Verbatim" });
    expect(useVocabulary.getState().terms[0]).toEqual(existing);
    expect(useVocabulary.getState().terms).toHaveLength(2);
  });

  it("does not overwrite unreadable vocabulary", async () => {
    storage.set("sw.vocab", '{"broken":true}');
    await expect(useVocabulary.getState().add({ term: "Kubernetes" })).rejects.toThrow(
      "could not be read",
    );
    expect(storage.get("sw.vocab")).toBe('{"broken":true}');
    expect(setItem).not.toHaveBeenCalled();
  });

  it("validates updates and imports without partially writing invalid batches", async () => {
    const existing = await useVocabulary.getState().add({ term: "Kubernetes" });
    const second = await useVocabulary.getState().add({ term: "Verbatim" });
    await expect(
      useVocabulary.getState().update(second.id, { term: "kubernetes" }),
    ).rejects.toThrow("already");
    await expect(
      useVocabulary.getState().importMany([{ term: "New" }, { term: "new" }]),
    ).rejects.toThrow("already");
    expect(useVocabulary.getState().terms).toEqual([existing, second]);
  });
});
