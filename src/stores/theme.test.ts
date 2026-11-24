// Appearance preferences: legacy storage migration, persistence shape, and the
// resolved-mode helper. Document attributes are applied in `applyResolved`,
// which is a no-op outside the browser (node test environment).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.resetModules();
  // Node 22 exposes an experimental `localStorage`; stub a normal Web Storage
  // object (same approach as layout.test.ts).
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme store", () => {
  it("defaults to system + notion when nothing is stored", async () => {
    const { useTheme } = await import("./theme");
    const s = useTheme.getState();
    expect(s.preference).toBe("system");
    expect(s.scheme).toBe("notion");
  });

  it("reads the legacy bare-string preference format", async () => {
    storage.set("nothing.theme", "dark");
    const { useTheme } = await import("./theme");
    expect(useTheme.getState().preference).toBe("dark");
    expect(useTheme.getState().scheme).toBe("notion");
  });

  it("persists both dimensions as JSON", async () => {
    const { useTheme } = await import("./theme");
    useTheme.getState().setScheme("fluent");
    expect(JSON.parse(storage.get("nothing.theme") ?? "null")).toEqual({
      preference: "system",
      scheme: "fluent",
    });

    useTheme.getState().setPreference("light");
    expect(JSON.parse(storage.get("nothing.theme") ?? "null")).toEqual({
      preference: "light",
      scheme: "fluent",
    });
  });

  it("falls back to notion on unknown stored schemes", async () => {
    storage.set("nothing.theme", JSON.stringify({ preference: "dark", scheme: "mica" }));
    const { useTheme } = await import("./theme");
    expect(useTheme.getState().scheme).toBe("notion");
    expect(useTheme.getState().preference).toBe("dark");
  });

  it("resolveTheme resolves explicit modes without matchMedia", async () => {
    const { resolveTheme } = await import("./theme");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("light");
  });
});