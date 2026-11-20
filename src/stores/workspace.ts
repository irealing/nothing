// Global workspace state. All backend calls go through src/ipc (AGENTS.md);
// errors are caught here and surfaced via `error` for the toast component.
//
// Rows are loaded lazily in windows (PAGE_SIZE pages) so 100k-row tables
// scroll smoothly: `rowsCache` maps absolute row index → Row, `total` is the
// full match count, and `dataVersion` invalidates everything on writes.

import { errorText, t } from "../i18n";
import { create } from "zustand";
import * as ipc from "../ipc";
import type {
  Cells,
  ColumnMeta,
  ColumnPatch,
  GridConfig,
  ImportCsvOptions,
  ImportReport,
  Json,
  NewColumn,
  NewView,
  Row,
  RowPage,
  SqlResult,
  TableMeta,
  ViewConfig,
  ViewMeta,
  ViewPatch,
  WorkspaceInfo,
} from "../types";

export const PAGE_SIZE = 200;

export function defaultGridConfig(): GridConfig {
  return { filters: null, sorts: [], hidden_columns: [] };
}

/** What the row window pipeline currently reads from. */
type Source =
  | { kind: "none" }
  | { kind: "view"; viewId: string }
  | { kind: "table"; tableId: string }
  | { kind: "search"; tableId: string; query: string };

interface WorkspaceState {
  info: WorkspaceInfo | null;
  tables: TableMeta[];
  activeTableId: string | null;
  /** All columns of the active table (panels, dialogs). */
  columns: ColumnMeta[];
  /** Columns the current source actually returns (view-hidden applied). */
  visibleColumns: ColumnMeta[];
  /** Grid views of the active table + workspace-level SQL views. */
  views: ViewMeta[];
  activeViewId: string | null;

  // windowed row data
  source: Source;
  total: number;
  rowsCache: Map<number, Row>;
  /** Bumped whenever rowsCache/total change — TableView re-renders on it. */
  rowsVersion: number;
  /** Bumped on any write; in-flight fetches with an older version are dropped. */
  dataVersion: number;
  /** rid → title, accumulated across fetched windows. */
  titles: Record<string, string>;

  sqlResult: SqlResult | null;
  searchQuery: string;
  loading: boolean;
  error: string | null;

  // windowed loading
  fetchWindow: (start: number, end: number) => Promise<void>;

  // workspace lifecycle
  openWorkspace: (path: string, password: string) => Promise<void>;
  createWorkspace: (path: string, password: string) => Promise<void>;
  closeWorkspace: () => Promise<void>;
  changePassword: (pw: string) => Promise<void>;
  clearError: () => void;

  // navigation
  selectTable: (id: string) => Promise<void>;
  selectView: (viewId: string | null) => Promise<void>;
  refresh: () => Promise<void>;

  // tables & columns
  createTable: (name: string, columns: NewColumn[], icon?: string | null) => Promise<void>;
  importCsv: (options: ImportCsvOptions) => Promise<ImportReport | null>;
  deleteTable: (id: string) => Promise<void>;
  renameTable: (id: string, name: string) => Promise<void>;
  setTableIcon: (id: string, icon: string | null) => Promise<void>;
  setTitleColumn: (colId: string) => Promise<void>;
  addColumn: (col: NewColumn) => Promise<void>;
  updateColumn: (colId: string, patch: ColumnPatch) => Promise<void>;
  deleteColumn: (colId: string) => Promise<void>;

  // views
  createGridView: (name: string) => Promise<void>;
  createSqlView: (name: string, statement: string) => Promise<void>;
  updateView: (viewId: string, patch: ViewPatch) => Promise<void>;
  deleteView: (viewId: string) => Promise<void>;

  // rows
  insertRow: (cells?: Cells) => Promise<void>;
  updateCell: (rid: string, colId: string, value: Json) => Promise<void>;
  deleteRows: (rids: string[]) => Promise<void>;
  searchRows: (query: string) => Promise<void>;
}

async function guard<R>(
  set: (p: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
  fn: () => Promise<R>,
): Promise<R | undefined> {
  set({ loading: true, error: null });
  try {
    return await fn();
  } catch (e) {
    set({ error: errorText(e) });
    return undefined;
  } finally {
    set({ loading: false });
    void get;
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Fetch one aligned page from the current source into the cache. */
  async function fetchPage(source: Source, offset: number, version: number): Promise<void> {
    let gridPage: RowPage;
    switch (source.kind) {
      case "view": {
        const res = await ipc.viewRun(source.viewId, PAGE_SIZE, offset);
        if (res.kind !== "grid") return; // sql views don't page
        gridPage = res;
        break;
      }
      case "table":
        gridPage = await ipc.rowList(source.tableId, PAGE_SIZE, offset);
        break;
      case "search":
        gridPage = await ipc.search(source.tableId, source.query, PAGE_SIZE, offset);
        break;
      case "none":
        return;
    }
    // Drop stale responses (a write happened while we were in flight).
    if (get().dataVersion !== version) return;
    const cache = get().rowsCache;
    gridPage.rows.forEach((r, i) => cache.set(offset + i, r));
    set({
      total: gridPage.total,
      visibleColumns: gridPage.columns,
      titles: { ...get().titles, ...gridPage.titles },
      rowsVersion: get().rowsVersion + 1,
    });
  }

  async function fetchWindowInternal(start: number, end: number) {
    const { source, total, rowsCache, dataVersion } = get();
    if (source.kind === "none") return;
    const from = Math.max(0, Math.floor(start / PAGE_SIZE) * PAGE_SIZE);
    // Upper bound: known total when available, otherwise just the request.
    const to = total > 0 ? Math.min(end, total) : end;
    const inflight: Promise<void>[] = [];
    for (let p = from; p < to; p += PAGE_SIZE) {
      // Skip pages already fully cached (bounded by total when known).
      const pageEnd = total > 0 ? Math.min(p + PAGE_SIZE, total) : p + PAGE_SIZE;
      let complete = true;
      for (let i = p; i < pageEnd; i++) {
        if (!rowsCache.has(i)) {
          complete = false;
          break;
        }
      }
      if (!complete) inflight.push(fetchPage(source, p, dataVersion));
    }
    await Promise.all(inflight);
  }

  /** Reset row state and prime the first window for a new source. */
  async function prime(source: Source) {
    set((s) => ({
      source,
      rowsCache: new Map(),
      total: 0,
      titles: {},
      dataVersion: s.dataVersion + 1,
      rowsVersion: s.rowsVersion + 1,
    }));
    await fetchWindowInternal(0, PAGE_SIZE);
  }

  /** Load columns + views for a table and activate a view (Notion-style:
   * every table always has at least one grid view). */
  async function loadTableData(tableId: string, viewId: string | null) {
    const [columns, views] = await Promise.all([
      ipc.columnList(tableId),
      ipc.viewList(tableId),
    ]);
    set({ columns, views, activeViewId: viewId, sqlResult: null, searchQuery: "" });
    if (viewId) {
      const view = views.find((v) => v.id === viewId);
      if (view?.kind === "sql") {
        const result = await ipc.viewRun(viewId, 1000, 0);
        if (result.kind === "sql") {
          set({ sqlResult: result, source: { kind: "none" }, rowsCache: new Map(), total: 0 });
          return;
        }
      }
      if (view?.kind === "grid") {
        await prime({ kind: "view", viewId });
        return;
      }
    }
    await prime({ kind: "table", tableId });
  }

  async function activateTable(tableId: string) {
    const columns = await ipc.columnList(tableId);
    let views = await ipc.viewList(tableId);
    set({ activeTableId: tableId, columns, views, searchQuery: "" });
    let gridViews = views.filter((v) => v.kind === "grid");
    if (gridViews.length === 0) {
      await ipc.viewCreate({
        table_id: tableId,
        name: t("view.defaultName"),
        kind: "grid",
        config: { kind: "grid", ...defaultGridConfig() },
      } satisfies NewView);
      views = await ipc.viewList(tableId);
      set({ views });
      gridViews = views.filter((v) => v.kind === "grid");
    }
    await loadTableData(tableId, gridViews[0]?.id ?? null);
  }

  /** After a write: drop the cache and re-prime the current source. */
  async function afterWrite() {
    const { activeTableId, activeViewId, searchQuery } = get();
    if (!activeTableId) return;
    if (searchQuery) {
      await prime({ kind: "search", tableId: activeTableId, query: searchQuery });
      return;
    }
    const view = get().views.find((v) => v.id === activeViewId);
    if (view?.kind === "sql") {
      const result = await ipc.viewRun(view.id, 1000, 0);
      if (result.kind === "sql") set({ sqlResult: result });
      return;
    }
    if (view?.kind === "grid") {
      await prime({ kind: "view", viewId: view.id });
      return;
    }
    await prime({ kind: "table", tableId: activeTableId });
  }

  return {
    info: null,
    tables: [],
    activeTableId: null,
    columns: [],
    visibleColumns: [],
    views: [],
    activeViewId: null,
    source: { kind: "none" },
    total: 0,
    rowsCache: new Map(),
    rowsVersion: 0,
    dataVersion: 0,
    titles: {},
    sqlResult: null,
    searchQuery: "",
    loading: false,
    error: null,

    fetchWindow: async (start, end) => {
      // High-frequency (scroll) path: no global loading flag, errors only
      // surface via toast-less console to avoid flicker; prime paths report.
      try {
        await fetchWindowInternal(start, end);
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    clearError: () => set({ error: null }),

    openWorkspace: async (path, password) => {
      await guard(set, get, async () => {
        const info = await ipc.workspaceOpen(path, password);
        const tables = await ipc.tableList();
        set({
          info,
          tables,
          activeTableId: null,
          columns: [],
          visibleColumns: [],
          views: [],
          rowsCache: new Map(),
          total: 0,
          titles: {},
          sqlResult: null,
          source: { kind: "none" },
        });
        if (tables.length > 0) await activateTable(tables[0].id);
      });
    },

    createWorkspace: async (path, password) => {
      await guard(set, get, async () => {
        const info = await ipc.workspaceCreate(path, password);
        set({
          info,
          tables: [],
          activeTableId: null,
          columns: [],
          visibleColumns: [],
          views: [],
          rowsCache: new Map(),
          total: 0,
          titles: {},
          sqlResult: null,
          searchQuery: "",
          source: { kind: "none" },
        });
      });
    },

    closeWorkspace: async () => {
      await guard(set, get, async () => {
        await ipc.workspaceClose();
        set({
          info: null,
          tables: [],
          activeTableId: null,
          columns: [],
          visibleColumns: [],
          views: [],
          activeViewId: null,
          rowsCache: new Map(),
          total: 0,
          titles: {},
          sqlResult: null,
          searchQuery: "",
          source: { kind: "none" },
        });
      });
    },

    changePassword: async (pw) => {
      await guard(set, get, () => ipc.workspaceChangePassword(pw));
    },

    selectTable: async (id) => {
      await guard(set, get, () => activateTable(id));
    },

    selectView: async (viewId) => {
      const { activeTableId } = get();
      if (!activeTableId) return;
      await guard(set, get, () => loadTableData(activeTableId, viewId));
    },

    refresh: async () => {
      await guard(set, get, async () => {
        set({ tables: await ipc.tableList() });
        await afterWrite();
      });
    },

    createTable: async (name, columns, icon) => {
      await guard(set, get, async () => {
        const t = await ipc.tableCreate(name, columns, icon);
        set({ tables: await ipc.tableList() });
        await activateTable(t.id);
      });
    },

    importCsv: async (options) => {
      // Returns the report so the dialog can show counts; on failure the
      // existing toast carries the error and the dialog stays open.
      set({ loading: true, error: null });
      try {
        const report = await ipc.csvImport(options);
        set({ tables: await ipc.tableList() });
        await activateTable(report.table.id);
        return report;
      } catch (e) {
        set({ error: errorText(e) });
        return null;
      } finally {
        set({ loading: false });
      }
    },

    deleteTable: async (id) => {
      await guard(set, get, async () => {
        await ipc.tableDelete(id);
        const tables = await ipc.tableList();
        set({ tables });
        if (get().activeTableId === id) {
          const next = tables[0]?.id ?? null;
          set({
            activeTableId: next,
            columns: [],
            visibleColumns: [],
            views: [],
            rowsCache: new Map(),
            total: 0,
            titles: {},
            sqlResult: null,
            source: { kind: "none" },
          });
          if (next) await activateTable(next);
        }
      });
    },

    renameTable: async (id, name) => {
      await guard(set, get, async () => {
        await ipc.tableRename(id, name);
        set({ tables: await ipc.tableList() });
      });
    },

    setTableIcon: async (id, icon) => {
      await guard(set, get, async () => {
        await ipc.tableSetIcon(id, icon);
        // Presentation-only: refresh the table list, don't refetch rows.
        set({ tables: await ipc.tableList() });
      });
    },

    setTitleColumn: async (colId) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.tableSetTitle(activeTableId, colId);
        set({ tables: await ipc.tableList() });
        await afterWrite();
      });
    },

    addColumn: async (col) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.columnAdd(activeTableId, col);
        set({ columns: await ipc.columnList(activeTableId) });
        await afterWrite();
      });
    },

    updateColumn: async (colId, patch) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.columnUpdate(activeTableId, colId, patch);
        set({ columns: await ipc.columnList(activeTableId) });
        // Only shape/choices/formula changes can alter stored cell values;
        // renaming, recolouring or resizing a column is metadata-only.
        const affectsData = patch.type !== undefined || patch.opts !== undefined;
        if (affectsData) {
          await afterWrite();
        } else {
          set((s) => ({ rowsVersion: s.rowsVersion + 1 }));
        }
      });
    },

    deleteColumn: async (colId) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.columnDelete(activeTableId, colId);
        set({ columns: await ipc.columnList(activeTableId) });
        await afterWrite();
      });
    },

    createGridView: async (name) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        const v = await ipc.viewCreate({
          table_id: activeTableId,
          name,
          kind: "grid",
          config: { kind: "grid", ...defaultGridConfig() },
        });
        await loadTableData(activeTableId, v.id);
      });
    },

    createSqlView: async (name, statement) => {
      await guard(set, get, async () => {
        const v = await ipc.viewCreate({
          table_id: null,
          name,
          kind: "sql",
          config: { kind: "sql", statement },
        });
        const { activeTableId } = get();
        if (activeTableId) {
          set({ views: await ipc.viewList(activeTableId), activeViewId: v.id });
        }
        const result = await ipc.viewRun(v.id, 1000, 0);
        if (result.kind === "sql") {
          set({ sqlResult: result, source: { kind: "none" }, rowsCache: new Map(), total: 0 });
        }
      });
    },

    updateView: async (viewId, patch) => {
      await guard(set, get, async () => {
        await ipc.viewUpdate(viewId, patch);
        const { activeTableId, activeViewId } = get();
        if (!activeTableId) return;
        if (activeViewId === viewId) {
          await loadTableData(activeTableId, viewId);
        } else {
          set({ views: await ipc.viewList(activeTableId) });
        }
      });
    },

    deleteView: async (viewId) => {
      await guard(set, get, async () => {
        await ipc.viewDelete(viewId);
        const { activeTableId, activeViewId } = get();
        if (!activeTableId) return;
        if (activeViewId === viewId) {
          await activateTable(activeTableId);
        } else {
          set({ views: await ipc.viewList(activeTableId) });
        }
      });
    },

    insertRow: async (cells = {}) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.rowInsert(activeTableId, cells);
        await afterWrite();
      });
    },

    updateCell: async (rid, colId, value) => {
      await guard(set, get, async () => {
        const { activeTableId, activeViewId, searchQuery } = get();
        if (!activeTableId) return;
        const updated = await ipc.rowUpdate(activeTableId, rid, { [colId]: value });
        // Patch in place first for instant feedback (formula cells included —
        // the backend returns the recomputed row)…
        const cache = get().rowsCache;
        for (const [idx, r] of cache) {
          if (r.rid === rid) {
            cache.set(idx, { ...r, ...updated });
            break;
          }
        }
        set((s) => ({ rowsVersion: s.rowsVersion + 1 }));

        // …then only revalidate when the edit can change membership, ordering
        // or related titles: filtered/sorted views, active search, or relation
        // columns (their pills resolve through the backend title map). Plain
        // edits in an unfiltered grid keep the in-place patch authoritative,
        // so typing in a cell no longer refetches the page and flickers.
        const col = get().columns.find((c) => c.id === colId);
        const view = get().views.find((v) => v.id === activeViewId);
        const cfg = view?.config.kind === "grid" ? view.config : null;
        const stable =
          !searchQuery && (cfg === null || (cfg.filters === null && cfg.sorts.length === 0));
        if (!stable || col?.type === "relation") {
          await afterWrite();
        }
      });
    },

    deleteRows: async (rids) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.rowDelete(activeTableId, rids);
        await afterWrite();
      });
    },

    searchRows: async (query) => {
      await guard(set, get, async () => {
        const { activeTableId, activeViewId } = get();
        if (!activeTableId) return;
        if (!query) {
          set({ searchQuery: "" });
          await loadTableData(activeTableId, activeViewId);
          return;
        }
        set({ searchQuery: query, sqlResult: null });
        await prime({ kind: "search", tableId: activeTableId, query });
      });
    },
  };
});

export type { GridConfig, ViewConfig };
