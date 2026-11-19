// Unit tests for the ipc layer: command argument mapping and structured
// error translation (AGENTS.md: 前端对 stores 和 ipc 层做单测).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { IpcError, rowUpdate, viewRun, workspaceOpen } from "./index";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => vi.clearAllMocks());

describe("ipc argument mapping", () => {
  it("maps row_update args to camelCase as Tauri expects", async () => {
    mockInvoke.mockResolvedValue({});
    await rowUpdate("t1", "r1", { c1: "v" });
    expect(mockInvoke).toHaveBeenCalledWith("row_update", {
      tableId: "t1",
      rid: "r1",
      cells: { c1: "v" },
    });
  });

  it("passes null for undefined optional view scope", async () => {
    mockInvoke.mockResolvedValue([]);
    const { viewList } = await import("./index");
    await viewList();
    expect(mockInvoke).toHaveBeenCalledWith("view_list", { tableId: null });
  });

  it("forwards pagination to view_run", async () => {
    mockInvoke.mockResolvedValue({ kind: "grid" });
    await viewRun("v1", 50, 100);
    expect(mockInvoke).toHaveBeenCalledWith("view_run", {
      viewId: "v1",
      limit: 50,
      offset: 100,
    });
  });
});

describe("ipc error translation", () => {
  it("converts CommandError rejects into IpcError with kind", async () => {
    mockInvoke.mockRejectedValue({
      kind: "WrongPassword",
      message: "密码错误，无法解密该文件",
    });
    const err = await workspaceOpen("/x.nothing", "bad").catch((e) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(err.kind).toBe("WrongPassword");
    expect(err.message).toContain("密码");
  });

  it("wraps unknown rejections as kind Unknown", async () => {
    mockInvoke.mockRejectedValue("boom");
    const err = await workspaceOpen("/x", "p").catch((e) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(err.kind).toBe("Unknown");
    expect(err.message).toBe("boom");
  });

  it("treats error objects without message as Unknown", async () => {
    mockInvoke.mockRejectedValue({ code: 42 });
    const err = await workspaceOpen("/x", "p").catch((e) => e);
    expect(err.kind).toBe("Unknown");
  });
});
