// Appearance preference: legacy storage migration, persistence shape, and the
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
  it("defaults to system when nothing is stored", async () => {
    const { useTheme } = await import("./theme");
    expect(useTheme.getState().preference).toBe("system");
  });

  it("reads the legacy bare-string preference format", async () => {
    storage.set("nothing.theme", "dark");
    const { useTheme } = await import("./theme");
    expect(useTheme.getState().preference).toBe("dark");
  });

  it("reads the old JSON format and ignores the removed scheme field", async () => {
    storage.set("nothing.theme", JSON.stringify({ preference: "light", scheme: "fluent" }));
    const { useTheme } = await import("./theme");
    expect(useTheme.getState().preference).toBe("light");
  });

  it("persists the preference as a bare string", async () => {
    const { useTheme } = await import("./theme");
    useTheme.getState().setPreference("dark");
    expect(storage.get("nothing.theme")).toBe("dark");
  });

  it("falls back to system on unknown stored preferences", async () => {
    storage.set("nothing.theme", JSON.stringify({ preference: "mica" }));
    const { useTheme } = await import("./theme");
    expect(useTheme.getState().preference).toBe("system");
  });

  it("resolveTheme resolves explicit modes without matchMedia", async () => {
    const { resolveTheme } = await import("./theme");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("light");
  });
});