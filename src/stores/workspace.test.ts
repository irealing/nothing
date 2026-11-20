// Unit tests for the workspace store: flows, error capture, in-place cell
// patching, search state transitions. The ipc layer is mocked wholesale.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc");

import * as ipc from "../ipc";
import type { ColumnMeta, RowPage, TableMeta, ViewMeta } from "../types";
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

describe("view actions", () => {
  const GRID_V: ViewMeta = {
    id: "v1",
    table_id: "t1",
    name: "默认视图",
    kind: "grid",
    config: { kind: "grid", filters: null, sorts: [], hidden_columns: [] },
    position: 0,
    created_at: "",
  };
  const GRID_V2: ViewMeta = { ...GRID_V, id: "v2", name: "视图 2" };
  const SQL_V: ViewMeta = {
    id: "vs",
    table_id: null,
    name: "统计",
    kind: "sql",
    config: { kind: "sql", statement: "SELECT 1" },
    position: 0,
    created_at: "",
  };
  const gridResult = { kind: "grid" as const, ...page() };

  it("auto-creates a default grid view when the table has none", async () => {
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList)
      .mockResolvedValueOnce([]) // activateTable initial fetch
      .mockResolvedValue([GRID_V]); // after creation / loadTableData
    vi.mocked(ipc.viewCreate).mockResolvedValue(GRID_V);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult);

    await useWorkspace.getState().selectTable("t1");

    expect(ipc.viewCreate).toHaveBeenCalledWith(
      expect.objectContaining({ table_id: "t1", kind: "grid", name: "默认视图" }),
    );
    const s = useWorkspace.getState();
    expect(s.activeViewId).toBe("v1");
    expect(s.page?.rows.length).toBe(1);
  });

  it("deleteView falls back to the first remaining grid view", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [GRID_V, GRID_V2],
      activeViewId: "v1",
      page: page(),
    });
    vi.mocked(ipc.viewDelete).mockResolvedValue(undefined);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V2]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult);

    await useWorkspace.getState().deleteView("v1");

    expect(useWorkspace.getState().activeViewId).toBe("v2");
    expect(ipc.viewCreate).not.toHaveBeenCalled(); // v2 exists, no auto-create
  });

  it("createSqlView activates the view and stores its result", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [GRID_V],
      activeViewId: "v1",
    });
    vi.mocked(ipc.viewCreate).mockResolvedValue(SQL_V);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V, SQL_V]);
    vi.mocked(ipc.viewRun).mockResolvedValue({
      kind: "sql",
      columns: [{ name: "n", decl_type: "INTEGER" }],
      rows: [[1]],
    });

    await useWorkspace.getState().createSqlView("统计", "SELECT count(*) AS n FROM t_x");

    const s = useWorkspace.getState();
    expect(s.activeViewId).toBe("vs");
    expect(s.sqlResult?.rows).toEqual([[1]]);
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
