import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayout } from "./layout";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  // Node 22 exposes an experimental `localStorage` that throws unless a file
  // is configured; stub it so the store sees a normal Web Storage object.
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  useLayout.setState({ sidebarCollapsed: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("layout store", () => {
  it("toggles the sidebar and persists the preference", () => {
    useLayout.getState().toggleSidebar();
    expect(useLayout.getState().sidebarCollapsed).toBe(true);
    expect(storage.get("nothing.layout.sidebar")).toBe("collapsed");

    useLayout.getState().toggleSidebar();
    expect(useLayout.getState().sidebarCollapsed).toBe(false);
    expect(storage.get("nothing.layout.sidebar")).toBe("expanded");
  });
});