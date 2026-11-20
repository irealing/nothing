// Unit tests for the workspace store: flows, error capture, windowed row
// cache, search state transitions. The ipc layer is mocked wholesale.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc");

import * as ipc from "../ipc";
import type { ColumnMeta, Row, RowPage, TableMeta, ViewMeta, ViewResult } from "../types";
import { PAGE_SIZE, useWorkspace } from "./workspace";

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

function row(rid: string, value = "a"): Row {
  return { rid, created: "", updated: "", cells: { c1: value } };
}

function page(rows: Row[], total = rows.length): RowPage {
  return { columns: [COL], rows, total, titles: {} };
}

function gridResult(rows: Row[], total = rows.length): ViewResult {
  return { kind: "grid", ...page(rows, total) };
}

/** A full PAGE_SIZE page starting at `offset` (for windowing tests). */
function fullPage(offset: number, total: number): RowPage {
  const n = Math.max(0, Math.min(PAGE_SIZE, total - offset));
  return page(
    Array.from({ length: n }, (_, i) => row(`r${offset + i}`)),
    total,
  );
}

// The real IpcError is automocked away by vi.mock("../ipc"); the store only
// relies on `instanceof Error` + `.message`, so a local subclass is faithful.
class FakeIpcError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

const dataState = {
  info: null,
  tables: [],
  activeTableId: null,
  columns: [],
  visibleColumns: [],
  views: [],
  activeViewId: null,
  source: { kind: "none" as const },
  total: 0,
  rowsCache: new Map<number, Row>(),
  rowsVersion: 0,
  dataVersion: 0,
  titles: {},
  sqlResult: null,
  searchQuery: "",
  loading: false,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspace.setState({ ...dataState, rowsCache: new Map() });
});

describe("openWorkspace", () => {
  it("loads info, tables and activates the first table's grid view", async () => {
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: "/a.nothing", format_version: 1 });
    vi.mocked(ipc.tableList).mockResolvedValue([T1]);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1")]));

    await useWorkspace.getState().openWorkspace("/a.nothing", "pw");

    const s = useWorkspace.getState();
    expect(s.error).toBeNull();
    expect(s.info?.path).toBe("/a.nothing");
    expect(s.activeTableId).toBe("t1");
    expect(s.activeViewId).toBe("v1");
    expect(s.total).toBe(1);
    expect(s.rowsCache.get(0)?.rid).toBe("r1");
    expect(ipc.viewRun).toHaveBeenCalledWith("v1", PAGE_SIZE, 0);
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

describe("windowed loading", () => {
  async function openWithTotal(total: number) {
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: "/a.nothing", format_version: 1 });
    vi.mocked(ipc.tableList).mockResolvedValue([T1]);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V]);
    vi.mocked(ipc.viewRun).mockResolvedValue({ kind: "grid", ...fullPage(0, total) });
    await useWorkspace.getState().openWorkspace("/a.nothing", "pw");
  }

  it("fetchWindow loads missing pages and skips cached ones", async () => {
    await openWithTotal(1000);
    vi.mocked(ipc.viewRun).mockClear();
    vi.mocked(ipc.viewRun).mockResolvedValue({ kind: "grid", ...fullPage(800, 1000) });

    // 900..1100 aligns to page 800 (1000 clamped by total) → one fetch
    await useWorkspace.getState().fetchWindow(900, 1100);
    expect(vi.mocked(ipc.viewRun).mock.calls.map((c) => c[2])).toEqual([800]);
    expect(useWorkspace.getState().rowsCache.get(999)?.rid).toBe("r999");

    // fully cached page → no fetch
    vi.mocked(ipc.viewRun).mockClear();
    await useWorkspace.getState().fetchWindow(900, 950);
    expect(ipc.viewRun).not.toHaveBeenCalled();
  });

  it("stale responses are dropped after a write bumps dataVersion", async () => {
    await openWithTotal(1000);
    let release: (v: ViewResult) => void = () => {};
    vi.mocked(ipc.viewRun).mockImplementation(
      () =>
        new Promise<ViewResult>((res) => {
          release = res;
        }),
    );
    const pending = useWorkspace.getState().fetchWindow(400, 600);
    // a write happens mid-flight
    useWorkspace.setState((s) => ({ dataVersion: s.dataVersion + 1 }));
    release(gridResult([row("stale")], 1000));
    await pending;
    expect(useWorkspace.getState().rowsCache.has(400)).toBe(false);
  });
});

describe("updateCell", () => {
  it("patches in place, then revalidates the window", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [GRID_V],
      activeViewId: "v1",
      source: { kind: "view", viewId: "v1" },
      rowsCache: new Map([[0, row("r1", "a")]]),
      total: 1,
    });
    vi.mocked(ipc.rowUpdate).mockResolvedValue(row("r1", "b"));
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1", "b")], 1));

    await useWorkspace.getState().updateCell("r1", "c1", "b");

    expect(ipc.rowUpdate).toHaveBeenCalledWith("t1", "r1", { c1: "b" });
    const s = useWorkspace.getState();
    expect(s.rowsCache.get(0)?.cells.c1).toBe("b");
    // revalidation re-ran the view
    expect(ipc.viewRun).toHaveBeenCalled();
  });

  it("surfaces backend rejections and keeps old data", async () => {
    useWorkspace.setState({
      activeTableId: "t1",
      source: { kind: "table", tableId: "t1" },
      rowsCache: new Map([[0, row("r1", "a")]]),
      total: 1,
    });
    vi.mocked(ipc.rowUpdate).mockRejectedValue(
      new FakeIpcError("InvalidInput", "「摸鱼」不是列「状态」的有效选项"),
    );
    await useWorkspace.getState().updateCell("r1", "c1", "摸鱼");
    const s = useWorkspace.getState();
    expect(s.error).toContain("有效选项");
    expect(s.rowsCache.get(0)?.cells.c1).toBe("a");
  });
});

describe("view actions", () => {
  it("auto-creates a default grid view when the table has none", async () => {
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList)
      .mockResolvedValueOnce([]) // activateTable initial fetch
      .mockResolvedValue([GRID_V]); // after creation / loadTableData
    vi.mocked(ipc.viewCreate).mockResolvedValue(GRID_V);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1")]));

    await useWorkspace.getState().selectTable("t1");

    expect(ipc.viewCreate).toHaveBeenCalledWith(
      expect.objectContaining({ table_id: "t1", kind: "grid", name: "默认视图" }),
    );
    const s = useWorkspace.getState();
    expect(s.activeViewId).toBe("v1");
    expect(s.rowsCache.get(0)?.rid).toBe("r1");
  });

  it("deleteView falls back to the first remaining grid view", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [GRID_V, GRID_V2],
      activeViewId: "v1",
      source: { kind: "view", viewId: "v1" },
      rowsCache: new Map([[0, row("r1")]]),
      total: 1,
    });
    vi.mocked(ipc.viewDelete).mockResolvedValue(undefined);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V2]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1")]));

    await useWorkspace.getState().deleteView("v1");

    expect(useWorkspace.getState().activeViewId).toBe("v2");
    expect(ipc.viewCreate).not.toHaveBeenCalled();
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
  it("primes a search source then restores the view on clear", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [GRID_V],
      activeViewId: "v1",
      source: { kind: "view", viewId: "v1" },
      rowsCache: new Map([[0, row("r1")]]),
      total: 1,
    });
    vi.mocked(ipc.search).mockResolvedValue(page([row("hit")], 42));

    await useWorkspace.getState().searchRows("关键词");
    let s = useWorkspace.getState();
    expect(s.searchQuery).toBe("关键词");
    expect(s.total).toBe(42);
    expect(s.rowsCache.get(0)?.rid).toBe("hit");
    expect(ipc.search).toHaveBeenCalledWith("t1", "关键词", PAGE_SIZE, 0);

    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V]);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1")], 1));
    await useWorkspace.getState().searchRows("");
    s = useWorkspace.getState();
    expect(s.searchQuery).toBe("");
    expect(s.total).toBe(1);
    expect(s.rowsCache.get(0)?.rid).toBe("r1");
  });
});
