// Unit tests for the About dialog's commit abbreviation. The component itself
// needs no test; the string handling in `shortRev` is easy to get wrong when
// `git describe` adds tag/distance/dirty decorations.

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { shortRev } from "./AboutDialog";

describe("shortRev", () => {
  it("keeps a bare abbreviated SHA", () => {
    expect(shortRev("c95bf81")).toBe("c95bf81");
  });

  it("drops the tag and commit distance from git describe", () => {
    expect(shortRev("v0.1.0-3-gc95bf81")).toBe("c95bf81");
    expect(shortRev("v0.1.0-0-gc95bf81")).toBe("c95bf81");
  });

  it("keeps the dirty marker exactly once", () => {
    expect(shortRev("v0.1.0-3-gc95bf81-dirty")).toBe("c95bf81-dirty");
    expect(shortRev("c95bf81-dirty")).toBe("c95bf81-dirty");
  });

  it("passes non-git fallbacks through", () => {
    expect(shortRev("unknown")).toBe("unknown");
  });
});