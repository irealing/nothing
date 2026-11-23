// Unit tests for the ipc layer: command argument mapping and structured
// error translation (AGENTS.md: 前端对 stores 和 ipc 层做单测).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  appInfo,
  csvImport,
  csvPreview,
  IpcError,
  rowUpdate,
  settingsSetUi,
  tableCreate,
  tableSetIcon,
  takeOpenRequest,
  viewRun,
  workspaceOpen,
} from "./index";

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

  it("maps CSV preview and import arguments", async () => {
    mockInvoke.mockResolvedValue({});
    await csvPreview("/data/a.csv", 20);
    expect(mockInvoke).toHaveBeenCalledWith("csv_preview", {
      path: "/data/a.csv",
      previewRows: 20,
    });

    const options = {
      path: "/data/a.csv",
      table_name: "导入表",
      use_header: true,
      headers: ["标题", "数量"],
      types: ["text", "number"] as const,
    };
    await csvImport({ ...options, types: [...options.types] });
    expect(mockInvoke).toHaveBeenCalledWith("csv_import", {
      options: { ...options, types: [...options.types] },
    });
  });

  it("forwards the initial table icon and later icon edits", async () => {
    mockInvoke.mockResolvedValue({});
    await tableCreate("项目", [], "📊");
    expect(mockInvoke).toHaveBeenCalledWith("table_create", {
      name: "项目",
      columns: [],
      icon: "📊",
    });

    await tableSetIcon("t1", null);
    expect(mockInvoke).toHaveBeenCalledWith("table_set_icon", {
      tableId: "t1",
      icon: null,
    });
  });

  it("maps settings reads/writes and shell open requests", async () => {
    mockInvoke.mockResolvedValue({});
    await settingsSetUi("D:\\data\\a.nothing", "t1", null);
    expect(mockInvoke).toHaveBeenCalledWith("settings_set_ui", {
      path: "D:\\data\\a.nothing",
      tableId: "t1",
      viewId: null,
    });

    await takeOpenRequest();
    expect(mockInvoke).toHaveBeenCalledWith("take_open_request", {});
  });

  it("requests build metadata without arguments", async () => {
    mockInvoke.mockResolvedValue({ version: "0.1.0" });
    const info = await appInfo();
    expect(mockInvoke).toHaveBeenCalledWith("app_info", {});
    expect(info.version).toBe("0.1.0");
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
