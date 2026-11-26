// Unit tests for the workspace store: flows, error capture, windowed row
// cache, search state transitions. The ipc layer is mocked wholesale.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc");

import * as ipc from "../ipc";
import type {
  ColumnMeta,
  ImportCsvOptions,
  NewColumn,
  Row,
  RowPage,
  TableMeta,
  ViewColumnMeta,
  ViewMeta,
  ViewResult,
} from "../types";
import { AGGREGATE_LIMIT, PAGE_SIZE, useWorkspace } from "./workspace";
import { useHistory } from "./history";

const T1: TableMeta = {
  id: "t1",
  name: "任务",
  sql_name: "t_x",
  title_col_id: "c1",
  icon: null,
  color: null,
  position: 0,
  created_at: "",
  updated_at: "",
};

const COL: ColumnMeta = {
  id: "c1",
  table_id: "t1",
  name: "标题",
  position: 0,
  width: 160,
  icon: null,
  color: null,
  align: null,
  default_value: null,
  format: null,
  created_at: "",
  data: { kind: "text", sql_name: "c_x" },
};

const GRID_V: ViewMeta = {
  id: "v1",
  table_id: "t1",
  name: "默认视图",
  kind: "grid",
  icon: null,
  color: null,
  data: { kind: "grid", filters: null, sorts: [] },
  columns: [],
  position: 0,
  created_at: "",
};

const GRID_V2: ViewMeta = { ...GRID_V, id: "v2", name: "视图 2" };

const VC: ViewColumnMeta = {
  id: "vc1",
  column_id: "c1",
  position: 0,
  width: 160,
  hidden: false,
  frozen: false,
};

const GRID_V_LAYOUT: ViewMeta = { ...GRID_V, columns: [VC] };

const SQL_V: ViewMeta = {
  id: "vs",
  table_id: null,
  name: "统计",
  kind: "sql",
  icon: null,
  color: null,
  data: { kind: "sql", statement: "SELECT 1" },
  columns: [],
  position: 0,
  created_at: "",
};

const AGG_V: ViewMeta = {
  ...GRID_V,
  id: "va",
  name: "汇总",
  data: {
    kind: "grid",
    filters: null,
    sorts: [],
    aggregate: {
      group_by: [],
      metrics: [{ op: "count_rows", column_id: null }],
      sort: null,
    },
  },
};

const AGG_RESULT: ViewResult = {
  kind: "aggregate",
  columns: [
    {
      kind: "metric",
      column_id: null,
      op: "count_rows",
      value_type: "number",
      format: null,
    },
  ],
  rows: [[5]],
  total_groups: 1,
  base_rows: 5,
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
  allViews: [],
  activeViewId: null,
  lastWorkspace: null,
  recent: [],
  pendingPath: null,
  booted: false,
  source: { kind: "none" as const },
  total: 0,
  rowsCache: new Map<number, Row>(),
  rowsVersion: 0,
  dataVersion: 0,
  titles: {},
  sqlResult: null,
  searchQuery: "",
  scratch: { open: false, statement: "SELECT " },
  loading: false,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useHistory.getState().clear();
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
    expect(ipc.setWindowTitle).toHaveBeenCalledWith("a.nothing — Nothing");
  });

  it("loads every view for the sidebar tree", async () => {
    const T2: TableMeta = { ...T1, id: "t2", name: "项目" };
    const V2: ViewMeta = { ...GRID_V, id: "v2", table_id: "t2", name: "项目视图" };
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: "/a.nothing", format_version: 1 });
    vi.mocked(ipc.tableList).mockResolvedValue([T1, T2]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V, V2, SQL_V]);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().openWorkspace("/a.nothing", "pw");

    expect(useWorkspace.getState().allViews.map((v) => v.id)).toEqual(["v1", "v2", "vs"]);
  });

  it("restores the last table and view recorded for the file", async () => {
    const T2: TableMeta = { ...T1, id: "t2", name: "项目" };
    const V22: ViewMeta = { ...GRID_V, id: "v22", table_id: "t2", name: "项目视图" };
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: "/a.nothing", format_version: 2 });
    vi.mocked(ipc.tableList).mockResolvedValue([T1, T2]);
    vi.mocked(ipc.settingsUi).mockResolvedValue({ table_id: "t2", view_id: "v22" });
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([V22]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().openWorkspace("/a.nothing", "pw");

    const s = useWorkspace.getState();
    expect(ipc.settingsUi).toHaveBeenCalledWith("/a.nothing");
    expect(s.activeTableId).toBe("t2");
    expect(s.activeViewId).toBe("v22");
    // The restored selection is written back (it may have been repaired).
    expect(ipc.settingsSetUi).toHaveBeenCalledWith("/a.nothing", "t2", "v22");
  });

  it("restores a SQL view recorded for the file", async () => {
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: "/a.nothing", format_version: 2 });
    vi.mocked(ipc.tableList).mockResolvedValue([T1]);
    vi.mocked(ipc.settingsUi).mockResolvedValue({ table_id: "t1", view_id: "vs" });
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V, SQL_V]);
    vi.mocked(ipc.viewRun).mockResolvedValue({
      kind: "sql",
      columns: [{ name: "n", decl_type: "INTEGER" }],
      rows: [[1]],
    });

    await useWorkspace.getState().openWorkspace("/a.nothing", "pw");

    const s = useWorkspace.getState();
    expect(s.activeTableId).toBe("t1");
    expect(s.activeViewId).toBe("vs");
    expect(s.sqlResult?.rows).toEqual([[1]]);
    expect(ipc.viewRun).toHaveBeenCalledWith("vs", 1000, 0);
    expect(ipc.settingsSetUi).toHaveBeenCalledWith("/a.nothing", "t1", "vs");
  });

  it("falls back to the first table when the recorded ids are stale", async () => {
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: "/a.nothing", format_version: 2 });
    vi.mocked(ipc.tableList).mockResolvedValue([T1]);
    vi.mocked(ipc.settingsUi).mockResolvedValue({ table_id: "gone", view_id: "gone" });
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V2, GRID_V]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().openWorkspace("/a.nothing", "pw");

    const s = useWorkspace.getState();
    expect(s.activeTableId).toBe("t1");
    expect(s.activeViewId).toBe("v2");
    // The repaired selection is written back, so the next open skips the fallback.
    expect(ipc.settingsSetUi).toHaveBeenCalledWith("/a.nothing", "t1", "v2");
    expect(s.error).toBeNull();
  });

  it("captures WrongPassword as error state without opening", async () => {
    vi.mocked(ipc.workspaceOpen).mockRejectedValue(
      new FakeIpcError("WrongPassword", "密码错误，无法解密该文件"),
    );
    await useWorkspace.getState().openWorkspace("/a.nothing", "bad");
    const s = useWorkspace.getState();
    expect(s.info).toBeNull();
    expect(s.error).toContain("密码不正确");
    expect(s.loading).toBe(false);
  });
});

describe("boot", () => {
  it("loads recents and a queued shell open request", async () => {
    const last = { path: "/a.nothing", opened_at: "2026-01-01T00:00:00Z", exists: true };
    vi.mocked(ipc.settingsGet).mockResolvedValue({
      last_workspace: last,
      recent: [last, { path: "/b.nothing", opened_at: "2026-01-01T00:00:00Z", exists: false }],
    });
    vi.mocked(ipc.takeOpenRequest).mockResolvedValue("/c.nothing");

    await useWorkspace.getState().boot();

    const s = useWorkspace.getState();
    expect(s.booted).toBe(true);
    expect(s.lastWorkspace?.path).toBe("/a.nothing");
    expect(s.recent.map((r) => r.path)).toEqual(["/a.nothing", "/b.nothing"]);
    expect(s.pendingPath).toBe("/c.nothing");
  });

  it("still finishes booting when the settings file is unavailable", async () => {
    vi.mocked(ipc.settingsGet).mockRejectedValue(new Error("no config dir"));
    vi.mocked(ipc.takeOpenRequest).mockRejectedValue(new Error("no state"));

    await useWorkspace.getState().boot();

    const s = useWorkspace.getState();
    expect(s.booted).toBe(true);
    expect(s.lastWorkspace).toBeNull();
    expect(s.error).toBeNull();
  });
});

describe("importCsv", () => {
  const NEW_TABLE: TableMeta = { ...T1, id: "t2", name: "导入表", title_col_id: "c2" };
  const NEW_COL: ColumnMeta = { ...COL, id: "c2", table_id: "t2" };
  const NEW_VIEW: ViewMeta = { ...GRID_V, id: "v2", table_id: "t2" };
  const OPTIONS: ImportCsvOptions = {
    path: "/a.csv",
    table_name: "导入表",
    use_header: true,
    headers: ["标题"],
    types: ["text"],
  };

  it("imports, refreshes tables and activates the new table", async () => {
    const report = { table: NEW_TABLE, imported: 3, invalid_cells: 1 };
    vi.mocked(ipc.csvImport).mockResolvedValue(report);
    vi.mocked(ipc.tableList).mockResolvedValue([T1, NEW_TABLE]);
    vi.mocked(ipc.columnList).mockResolvedValue([NEW_COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([NEW_VIEW]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    const result = await useWorkspace.getState().importCsv(OPTIONS);

    expect(result).toEqual(report);
    expect(ipc.csvImport).toHaveBeenCalledWith(OPTIONS);
    expect(ipc.columnList).toHaveBeenCalledWith("t2");
    const s = useWorkspace.getState();
    expect(s.error).toBeNull();
    expect(s.tables.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.activeTableId).toBe("t2");
    expect(s.activeViewId).toBe("v2");
    expect(s.loading).toBe(false);
  });

  it("captures backend failures and keeps the current table active", async () => {
    useWorkspace.setState({ ...dataState, rowsCache: new Map(), activeTableId: "t1" });
    vi.mocked(ipc.csvImport).mockRejectedValue(
      new FakeIpcError("AlreadyExists", "名称已存在: 表 导入表"),
    );

    const result = await useWorkspace.getState().importCsv(OPTIONS);

    expect(result).toBeNull();
    const s = useWorkspace.getState();
    expect(s.activeTableId).toBe("t1");
    expect(s.error).toContain("名称已存在");
    expect(s.loading).toBe(false);
  });
});

describe("table icons", () => {
  it("setTableIcon refreshes the table list without refetching rows", async () => {
    useWorkspace.setState({ ...dataState, rowsCache: new Map(), tables: [T1], activeTableId: "t1" });
    const withIcon: TableMeta = { ...T1, icon: "📊" };
    vi.mocked(ipc.tableSetIcon).mockResolvedValue(withIcon);
    vi.mocked(ipc.tableList).mockResolvedValue([withIcon]);

    await useWorkspace.getState().setTableIcon("t1", "📊");

    const s = useWorkspace.getState();
    expect(ipc.tableSetIcon).toHaveBeenCalledWith("t1", "📊");
    expect(s.tables[0].icon).toBe("📊");
    expect(ipc.viewRun).not.toHaveBeenCalled();
    expect(s.error).toBeNull();
  });

  it("createTable forwards the initial emoji to the backend", async () => {
    const created: TableMeta = { ...T1, id: "t2", icon: "🚀" };
    const initial = { name: "标题", type: "text" } as NewColumn;
    vi.mocked(ipc.tableCreate).mockResolvedValue(created);
    vi.mocked(ipc.tableList).mockResolvedValue([created]);
    vi.mocked(ipc.columnList).mockResolvedValue([{ ...COL, table_id: "t2" }]);
    vi.mocked(ipc.viewList).mockResolvedValue([{ ...GRID_V, table_id: "t2" }]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().createTable("项目", [initial], "🚀");

    expect(ipc.tableCreate).toHaveBeenCalledWith("项目", [initial], "🚀");
    const s = useWorkspace.getState();
    expect(s.activeTableId).toBe("t2");
    expect(s.tables[0].icon).toBe("🚀");
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
  it("patches the cached row in place without refetching a stable view", async () => {
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

    await useWorkspace.getState().updateCell("r1", "c1", "b");

    expect(ipc.rowUpdate).toHaveBeenCalledWith("t1", "r1", { c1: "b" });
    const s = useWorkspace.getState();
    expect(s.rowsCache.get(0)?.cells.c1).toBe("b");
    // unfiltered + unsorted → the in-place patch is authoritative
    expect(ipc.viewRun).not.toHaveBeenCalled();
  });

  it("revalidates after an edit in a filtered view", async () => {
    const filtered: ViewMeta = {
      ...GRID_V,
      data: {
        kind: "grid",
        filters: { column_id: "c1", op: "contains", value: "b" },
        sorts: [],
      },
    };
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [filtered],
      activeViewId: "v1",
      source: { kind: "view", viewId: "v1" },
      rowsCache: new Map([[0, row("r1", "a")]]),
      total: 1,
    });
    vi.mocked(ipc.rowUpdate).mockResolvedValue(row("r1", "b"));
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1", "b")], 1));

    await useWorkspace.getState().updateCell("r1", "c1", "b");

    expect(ipc.viewRun).toHaveBeenCalled();
  });

  it("revalidates relation edits so linked titles resolve", async () => {
    const relCol: ColumnMeta = {
      ...COL,
      id: "c9",
      name: "负责人",
      data: { kind: "relation", target_table_id: "t2", single: false, origin_id: null },
    };
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL, relCol],
      views: [GRID_V],
      activeViewId: "v1",
      source: { kind: "view", viewId: "v1" },
      rowsCache: new Map([[0, row("r1", "a")]]),
      total: 1,
    });
    vi.mocked(ipc.rowUpdate).mockResolvedValue(row("r1", "a"));
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1", "a")], 1));

    await useWorkspace.getState().updateCell("r1", "c9", ["r2"]);

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
    expect(ipc.settingsSetUi).toHaveBeenCalledWith("/a.nothing", "t1", "vs");
  });

  it("createAggregateView inherits the current grid filters and runs it", async () => {
    const filteredGrid: ViewMeta = {
      ...GRID_V,
      data: {
        kind: "grid",
        filters: { column_id: "c1", op: "contains", value: "x" },
        sorts: [],
      },
    };
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [filteredGrid],
      activeViewId: "v1",
    });
    vi.mocked(ipc.viewCreate).mockResolvedValue(AGG_V);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([filteredGrid, AGG_V]);
    vi.mocked(ipc.viewRun).mockResolvedValue(AGG_RESULT);

    await useWorkspace.getState().createAggregateView("汇总");

    expect(ipc.viewCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        table_id: "t1",
        name: "汇总",
        kind: "grid",
        data: expect.objectContaining({
          filters: filteredGrid.data.kind === "grid" ? filteredGrid.data.filters : null,
          sorts: [],
          aggregate: expect.objectContaining({
            group_by: [],
            metrics: [{ op: "count_rows", column_id: null }],
          }),
        }),
      }),
    );
    const s = useWorkspace.getState();
    expect(s.activeViewId).toBe("va");
    expect(s.aggregateResult?.base_rows).toBe(5);
  });

  it("selectView runs a summary view on its own read path", async () => {
    useWorkspace.setState({
      ...dataState,
      info: { path: "/a.nothing", format_version: 1 },
      allViews: [AGG_V],
      views: [AGG_V],
      activeTableId: "t1",
      activeViewId: null,
    });
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([AGG_V]);
    vi.mocked(ipc.viewRun).mockResolvedValue(AGG_RESULT);

    await useWorkspace.getState().selectView("va");

    const s = useWorkspace.getState();
    expect(s.activeViewId).toBe("va");
    expect(s.aggregateResult?.rows).toEqual([[5]]);
    expect(s.source).toEqual({ kind: "none" });
    expect(ipc.viewRun).toHaveBeenCalledWith("va", AGGREGATE_LIMIT, 0);
  });

  it("selectView records the new active view for the workspace", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [GRID_V, GRID_V2],
      activeViewId: "v1",
    });
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V, GRID_V2]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().selectView("v2");

    expect(useWorkspace.getState().activeViewId).toBe("v2");
    expect(ipc.settingsSetUi).toHaveBeenCalledWith("/a.nothing", "t1", "v2");
  });

  it("selectTable can activate a specific view in one step", async () => {
    useWorkspace.setState({ ...dataState, rowsCache: new Map(), tables: [T1] });
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V, GRID_V2]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().selectTable("t1", "v2");

    expect(useWorkspace.getState().activeViewId).toBe("v2");
    expect(ipc.viewRun).toHaveBeenCalledWith("v2", PAGE_SIZE, 0);
  });

  it("selectView can run a SQL view without an active table", async () => {
    useWorkspace.setState({
      ...dataState,
      info: { path: "/a.nothing", format_version: 1 },
      allViews: [SQL_V],
      views: [SQL_V],
    });
    vi.mocked(ipc.viewRun).mockResolvedValue({
      kind: "sql",
      columns: [{ name: "n", decl_type: "INTEGER" }],
      rows: [[1]],
    });

    await useWorkspace.getState().selectView("vs");

    const s = useWorkspace.getState();
    expect(s.activeViewId).toBe("vs");
    expect(s.sqlResult?.rows).toEqual([[1]]);
    expect(ipc.columnList).not.toHaveBeenCalled();
  });

  it("updates a view icon without refetching rows", async () => {
    useWorkspace.setState({
      ...dataState,
      rowsCache: new Map([[0, row("r1")]]),
      activeTableId: "t1",
      activeViewId: "v1",
      views: [GRID_V],
      allViews: [GRID_V],
      source: { kind: "view", viewId: "v1" },
      total: 1,
    });
    const updated: ViewMeta = { ...GRID_V, icon: "🔥" };
    vi.mocked(ipc.viewUpdate).mockResolvedValue(updated);

    await useWorkspace.getState().updateView("v1", { icon: "🔥" });

    const s = useWorkspace.getState();
    expect(ipc.viewUpdate).toHaveBeenCalledWith("v1", { icon: "🔥" });
    expect(s.views[0].icon).toBe("🔥");
    expect(s.allViews[0].icon).toBe("🔥");
    expect(ipc.viewRun).not.toHaveBeenCalled();
    expect(ipc.columnList).not.toHaveBeenCalled();
  });

  it("a view position patch adopts the renumbered backend order", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      activeViewId: "v1",
      columns: [COL],
      views: [GRID_V, GRID_V2],
      allViews: [GRID_V, GRID_V2],
      source: { kind: "view", viewId: "v1" },
    });
    const moved: ViewMeta = { ...GRID_V, position: 1 };
    const other: ViewMeta = { ...GRID_V2, position: 0 };
    vi.mocked(ipc.viewUpdate).mockResolvedValue(moved);
    vi.mocked(ipc.viewList).mockResolvedValue([other, moved]);

    await useWorkspace.getState().updateView("v1", { position: 1 });

    expect(ipc.viewUpdate).toHaveBeenCalledWith("v1", { position: 1 });
    expect(ipc.viewList).toHaveBeenCalledWith("t1");
    const s = useWorkspace.getState();
    expect(s.views.map((v) => v.id)).toEqual(["v2", "v1"]);
    expect(s.allViews.map((v) => v.id)).toEqual(["v2", "v1"]);
    expect(ipc.viewRun).not.toHaveBeenCalled();
  });
});

describe("scratch query", () => {
  it("keeps the draft while the panel is closed and reopened", () => {
    const s = useWorkspace.getState();
    s.openScratch();
    s.setScratchStatement("SELECT 1");
    s.closeScratch();

    const afterClose = useWorkspace.getState();
    expect(afterClose.scratch.open).toBe(false);
    expect(afterClose.scratch.statement).toBe("SELECT 1");

    afterClose.openScratch();
    expect(useWorkspace.getState().scratch.open).toBe(true);
  });

  it("closes when switching to a table or a view", async () => {
    useWorkspace.setState({
      info: { path: "/a.nothing", format_version: 1 },
      tables: [T1],
      activeTableId: "t1",
      columns: [COL],
      views: [GRID_V, GRID_V2],
      activeViewId: "v1",
      scratch: { open: true, statement: "SELECT 1" },
    });
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewList).mockResolvedValue([GRID_V, GRID_V2]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().selectView("v2");
    expect(useWorkspace.getState().scratch.open).toBe(false);
    expect(useWorkspace.getState().scratch.statement).toBe("SELECT 1");

    useWorkspace.setState((s) => ({ scratch: { ...s.scratch, open: true } }));
    await useWorkspace.getState().selectTable("t1");
    expect(useWorkspace.getState().scratch.open).toBe(false);
  });

  it("discards the draft when the workspace closes", async () => {
    vi.mocked(ipc.workspaceClose).mockResolvedValue(undefined);
    useWorkspace.setState({ scratch: { open: true, statement: "SELECT 42" } });

    await useWorkspace.getState().closeWorkspace();

    expect(useWorkspace.getState().scratch).toEqual({ open: false, statement: "SELECT " });
    expect(ipc.setWindowTitle).toHaveBeenLastCalledWith("Nothing");
  });
});

describe("updateColumn", () => {
  it("refreshes the rendered columns in place for metadata-only edits", async () => {
    const updated: ColumnMeta = { ...COL, icon: "🔥" };
    useWorkspace.setState({
      activeTableId: "t1",
      columns: [COL],
      visibleColumns: [COL],
      views: [GRID_V],
      activeViewId: "v1",
    });
    vi.mocked(ipc.columnList).mockResolvedValue([updated]);

    await useWorkspace.getState().updateColumn("c1", { icon: "🔥" });

    const s = useWorkspace.getState();
    expect(s.columns[0].icon).toBe("🔥");
    // The grid reads `visibleColumns`, so it must be patched too (this is what
    // makes an icon/colour/rename change appear without refetching rows).
    expect(s.visibleColumns[0].icon).toBe("🔥");
    expect(ipc.viewRun).not.toHaveBeenCalled();
  });

  it("refetches rows when the column position changes", async () => {
    const moved: ColumnMeta = { ...COL, position: 1 };
    useWorkspace.setState({
      activeTableId: "t1",
      columns: [COL],
      visibleColumns: [COL],
      views: [GRID_V],
      activeViewId: "v1",
      source: { kind: "view", viewId: "v1" },
    });
    vi.mocked(ipc.columnList).mockResolvedValue([moved]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1")]));

    await useWorkspace.getState().updateColumn("c1", { position: 1 });

    expect(ipc.viewRun).toHaveBeenCalled();
    expect(useWorkspace.getState().columns[0].position).toBe(1);
  });
});

describe("updateViewColumn", () => {
  it("previews a width synchronously without touching ipc", () => {
    useWorkspace.setState({
      ...dataState,
      activeTableId: "t1",
      activeViewId: "v1",
      columns: [COL],
      visibleColumns: [COL],
      views: [GRID_V_LAYOUT],
      allViews: [GRID_V_LAYOUT],
    });

    useWorkspace.getState().previewViewColumnWidth("v1", "c1", 240);

    expect(useWorkspace.getState().visibleColumns[0].width).toBe(240);
    expect(ipc.viewColumnUpdate).not.toHaveBeenCalled();
    expect(ipc.viewList).not.toHaveBeenCalled();
    expect(ipc.viewRun).not.toHaveBeenCalled();
  });

  it("persists a width-only change without refetching views or rows", async () => {
    useWorkspace.setState({
      ...dataState,
      activeTableId: "t1",
      activeViewId: "v1",
      columns: [COL],
      visibleColumns: [{ ...COL, width: 240 }],
      views: [GRID_V_LAYOUT],
      allViews: [GRID_V_LAYOUT],
      source: { kind: "view", viewId: "v1" },
      rowsCache: new Map([[0, row("r1")]]),
      total: 1,
    });
    const updated: ViewColumnMeta = { ...VC, width: 240 };
    vi.mocked(ipc.viewColumnUpdate).mockResolvedValue(updated);

    await useWorkspace.getState().updateViewColumn("v1", "c1", { width: 240 });

    const s = useWorkspace.getState();
    expect(ipc.viewColumnUpdate).toHaveBeenCalledWith("v1", "c1", { width: 240 });
    expect(ipc.viewList).not.toHaveBeenCalled();
    expect(ipc.viewRun).not.toHaveBeenCalled();
    expect(s.visibleColumns[0].width).toBe(240);
    expect(s.views[0].columns[0].width).toBe(240);
    expect(s.allViews[0].columns[0].width).toBe(240);
    expect(s.rowsCache.size).toBe(1);
  });

  it("reorders visible columns locally without reloading rows", async () => {
    const C2: ColumnMeta = { ...COL, id: "c2", name: "状态", position: 1 };
    const VC2: ViewColumnMeta = {
      id: "vc2",
      column_id: "c2",
      position: 1,
      width: 160,
      hidden: false,
      frozen: false,
    };
    const layout: ViewMeta = { ...GRID_V, columns: [VC, VC2] };
    useWorkspace.setState({
      ...dataState,
      activeTableId: "t1",
      activeViewId: "v1",
      columns: [COL, C2],
      visibleColumns: [COL, C2],
      views: [layout],
      allViews: [layout],
      source: { kind: "view", viewId: "v1" },
    });
    vi.mocked(ipc.viewColumnUpdate).mockResolvedValue({ ...VC2, position: 0 });
    vi.mocked(ipc.viewList).mockResolvedValue([
      { ...layout, columns: [{ ...VC2, position: 0 }, { ...VC, position: 1 }] },
    ]);

    await useWorkspace.getState().updateViewColumn("v1", "c2", { position: 0 });

    const s = useWorkspace.getState();
    expect(ipc.viewList).toHaveBeenCalledWith("t1");
    expect(ipc.viewRun).not.toHaveBeenCalled();
    expect(s.visibleColumns.map((c) => c.id)).toEqual(["c2", "c1"]);
  });
});

describe("duplicateRows", () => {
  it("copies physical cells and skips formula and reverse columns", async () => {
    const formula: ColumnMeta = {
      ...COL,
      id: "cf",
      name: "合计",
      data: { kind: "formula", sql_name: "c_cf", expr: "[标题]", result_type: "text" },
    };
    const reverse: ColumnMeta = {
      ...COL,
      id: "cr",
      name: "反向关联",
      data: { kind: "relation", target_table_id: "t1", single: false, origin_id: "cl" },
    };
    const relation: ColumnMeta = {
      ...COL,
      id: "cl",
      name: "关联",
      data: { kind: "relation", target_table_id: "t1", single: false, origin_id: null },
    };
    const source: Row = {
      rid: "r1",
      created: "",
      updated: "",
      cells: { c1: "A", cf: "generated", cr: ["r9"], cl: ["r2"] },
    };
    useWorkspace.setState({
      activeTableId: "t1",
      columns: [COL, formula, reverse, relation],
      visibleColumns: [COL],
      views: [GRID_V],
      activeViewId: "v1",
      source: { kind: "view", viewId: "v1" },
    });
    vi.mocked(ipc.rowGet).mockResolvedValue(source);
    vi.mocked(ipc.rowInsert).mockResolvedValue({ ...source, rid: "r2" });
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1"), row("r2")]));

    await useWorkspace.getState().duplicateRows(["r1"]);

    expect(ipc.rowGet).toHaveBeenCalledWith("t1", "r1");
    expect(ipc.rowInsert).toHaveBeenCalledWith("t1", { c1: "A", cl: ["r2"] });
    expect(ipc.viewRun).toHaveBeenCalled();
  });

  it("does nothing without a selection", async () => {
    useWorkspace.setState({ activeTableId: "t1", columns: [COL] });
    await useWorkspace.getState().duplicateRows([]);
    expect(ipc.rowGet).not.toHaveBeenCalled();
    expect(ipc.rowInsert).not.toHaveBeenCalled();
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

describe("undo / redo", () => {
  const ready = () =>
    useWorkspace.setState({
      ...dataState,
      activeTableId: "t1",
      activeViewId: "v1",
      columns: [COL],
      visibleColumns: [COL],
      views: [GRID_V],
      source: { kind: "view", viewId: "v1" },
      rowsCache: new Map([[0, row("r1", "old")]]),
    });

  it("undoes a cell edit with the previous value", async () => {
    ready();
    vi.mocked(ipc.rowUpdate).mockResolvedValue(row("r1", "new"));
    vi.mocked(ipc.rowBatchUpdate).mockResolvedValue(1);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([row("r1", "new")]));

    await useWorkspace.getState().updateCell("r1", "c1", "new");
    expect(useHistory.getState().past).toHaveLength(1);

    await useWorkspace.getState().undo();
    expect(ipc.rowBatchUpdate).toHaveBeenCalledWith("t1", [["r1", { c1: "old" }]]);
    expect(useHistory.getState().past).toHaveLength(0);
    expect(useHistory.getState().future).toHaveLength(1);

    await useWorkspace.getState().redo();
    expect(ipc.rowBatchUpdate).toHaveBeenCalledWith("t1", [["r1", { c1: "new" }]]);
    expect(useHistory.getState().past).toHaveLength(1);
  });

  it("undoes a row delete by restoring the backend snapshot", async () => {
    ready();
    const snapshot = {
      table_id: "t1",
      rows: [{ rid: "r1", created: "", updated: "", cells: { c1: "old" } }],
      links: [],
    };
    vi.mocked(ipc.rowDelete).mockResolvedValue(snapshot);
    vi.mocked(ipc.rowRestore).mockResolvedValue(1);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().deleteRows(["r1"]);
    expect(ipc.rowDelete).toHaveBeenCalledWith("t1", ["r1"]);
    expect(useHistory.getState().past).toHaveLength(1);

    await useWorkspace.getState().undo();
    expect(ipc.rowRestore).toHaveBeenCalledWith(snapshot);

    // Redo deletes again and refreshes the snapshot for another undo.
    const second = { ...snapshot, links: [] };
    vi.mocked(ipc.rowDelete).mockResolvedValue(second);
    await useWorkspace.getState().redo();
    expect(ipc.rowDelete).toHaveBeenCalledTimes(2);
    await useWorkspace.getState().undo();
    expect(ipc.rowRestore).toHaveBeenLastCalledWith(second);
  });

  it("does not record bulk deletes above the undo limit", async () => {
    ready();
    const rids = Array.from({ length: 501 }, (_, i) => `r${i}`);
    vi.mocked(ipc.rowDelete).mockResolvedValue({
      table_id: "t1",
      rows: [],
      links: [],
    });
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().deleteRows(rids);
    expect(useHistory.getState().past).toHaveLength(0);
  });

  it("clears the stack when a column changes shape", async () => {
    ready();
    useHistory.getState().push({
      tableId: "t1",
      label: "edit",
      undo: async () => {},
      redo: async () => {},
    });
    vi.mocked(ipc.columnUpdate).mockResolvedValue(COL);
    vi.mocked(ipc.columnList).mockResolvedValue([COL]);
    vi.mocked(ipc.viewRun).mockResolvedValue(gridResult([]));

    await useWorkspace.getState().updateColumn("c1", { type: "number" });
    expect(useHistory.getState().past).toHaveLength(0);
  });
});