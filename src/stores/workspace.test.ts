// Unit tests for the workspace store: flows, error capture, in-place cell
// patching, search state transitions. The ipc layer is mocked wholesale.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc");

import * as ipc from "../ipc";
import type { ColumnMeta, RowPage, TableMeta } from "../types";
import { useWorkspace } from "./workspace";

// The real IpcError is automocked away by vi.mock("../ipc"); the store only
// relies on `instanceof Error` + `.message`, so a local subclass is faithful.
class FakeIpcError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

const T1: TableMeta = {
  id: "t1",
  name: "任务",
  sql_name: "t_x",
  title_col_id: "c1",
  icon: null,
  position: 0,
  created_at: "",
  updated_at: "",
};

const COL: ColumnMeta = {
  id: "c1",
  table_id: "t1",
  name: "标题",
  sql_name: "c_x",
  type: "text",
  opts: { kind: "plain" },
  position: 0,
  width: 160,
  visible: true,
  is_reverse: false,
  reverse_of: null,
  created_at: "",
};

function page(cellValue: string = "a"): RowPage {
  return {
    columns: [COL],
    rows: [{ rid: "r1", created: "", updated: "", cells: { c1: cellValue } }],
    total: 1,
    titles: {},
  };
}

const dataState = {
  info: null,
  tables: [],
  activeTableId: null,
  columns: [],
  views: [],
  activeViewId: null,
  page: null,
  sqlResult: null,
  searchQuery: "",
  loading: false,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspace.setState(dataState);
});

describe("openWorkspace", () => {
  it("loads info, tables and the first table's data", async () => {
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: "/a.nothing", format_version: 1 });
    vi.mocked(ipc.tableList).mockResolvedValue([T1]);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([]);
    vi.mocked(ipc.rowList).mockResolvedValue(page());

    await useWorkspace.getState().openWorkspace("/a.nothing", "pw");

    const s = useWorkspace.getState();
    expect(s.error).toBeNull();
    expect(s.info?.path).toBe("/a.nothing");
    expect(s.activeTableId).toBe("t1");
    expect(s.page?.rows[0].cells.c1).toBe("a");
    expect(ipc.rowList).toHaveBeenCalledWith("t1", 1000, 0);
  });

  it("captures WrongPassword as error state without opening", async () => {
    vi.mocked(ipc.workspaceOpen).mockRejectedValue(
      new FakeIpcError("WrongPassword", "密码错误，无法解密该文件"),
    );
    await useWorkspace.getState().openWorkspace("/a.nothing", "bad");
    const s = useWorkspace.getState();
    expect(s.info).toBeNull();
    expect(s.error).toContain("密码错误");
    expect(s.loading).toBe(false);
  });
});

describe("updateCell", () => {
  it("patches the row in place without a full reload", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      page: page("a"),
    });
    vi.mocked(ipc.rowUpdate).mockResolvedValue({
      rid: "r1",
      created: "",
      updated: "now",
      cells: { c1: "b" },
    });

    await useWorkspace.getState().updateCell("r1", "c1", "b");

    const s = useWorkspace.getState();
    expect(s.error).toBeNull();
    expect(s.page?.rows[0].cells.c1).toBe("b");
    // 关键：不能触发整页刷新（rowList 未被调用）
    expect(ipc.rowList).not.toHaveBeenCalled();
  });

  it("surfaces backend rejections and keeps old data", async () => {
    useWorkspace.setState({ activeTableId: "t1", page: page("a") });
    vi.mocked(ipc.rowUpdate).mockRejectedValue(
      new FakeIpcError("InvalidInput", "「摸鱼」不是列「状态」的有效选项"),
    );
    await useWorkspace.getState().updateCell("r1", "c1", "摸鱼");
    const s = useWorkspace.getState();
    expect(s.error).toContain("有效选项");
    expect(s.page?.rows[0].cells.c1).toBe("a");
  });
});

describe("searchRows", () => {
  it("sets search page then restores the view on clear", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      page: page(),
    });
    const searchPage = page("hit");
    searchPage.total = 42;
    vi.mocked(ipc.search).mockResolvedValue(searchPage);

    await useWorkspace.getState().searchRows("关键词");
    let s = useWorkspace.getState();
    expect(s.searchQuery).toBe("关键词");
    expect(s.page?.total).toBe(42);
    expect(ipc.search).toHaveBeenCalledWith("t1", "关键词", 1000, 0);

    // clearing falls back to the plain table listing
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([]);
    vi.mocked(ipc.rowList).mockResolvedValue(page());
    await useWorkspace.getState().searchRows("");
    s = useWorkspace.getState();
    expect(s.searchQuery).toBe("");
    expect(s.page?.total).toBe(1);
    expect(ipc.rowList).toHaveBeenCalled();
  });
});
