// Global workspace state. All backend calls go through src/ipc (AGENTS.md);
// errors are caught here and surfaced via `error` for the toast component.

import { create } from "zustand";
import * as ipc from "../ipc";
import type {
  Cells,
  ColumnMeta,
  ColumnPatch,
  GridConfig,
  Json,
  NewColumn,
  NewView,
  RowPage,
  SqlResult,
  TableMeta,
  ViewConfig,
  ViewMeta,
  ViewPatch,
  WorkspaceInfo,
} from "../types";

export function defaultGridConfig(): GridConfig {
  return { filters: null, sorts: [], hidden_columns: [] };
}

interface WorkspaceState {
  info: WorkspaceInfo | null;
  tables: TableMeta[];
  activeTableId: string | null;
  columns: ColumnMeta[];
  /** Grid views of the active table + workspace-level SQL views. */
  views: ViewMeta[];
  /** null = raw table data fallback; normally a grid or SQL view id. */
  activeViewId: string | null;
  page: RowPage | null;
  sqlResult: SqlResult | null;
  /** Non-empty when the grid is showing search results instead of the view. */
  searchQuery: string;
  loading: boolean;
  error: string | null;

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
  createTable: (name: string, columns: NewColumn[]) => Promise<void>;
  deleteTable: (id: string) => Promise<void>;
  renameTable: (id: string, name: string) => Promise<void>;
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
    set({ error: e instanceof Error ? e.message : String(e) });
    return undefined;
  } finally {
    set({ loading: false });
    void get;
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Load columns + views + the given view's data (or raw rows). */
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
          set({ sqlResult: result, page: null });
          return;
        }
      }
      if (view?.kind === "grid") {
        const result = await ipc.viewRun(viewId, 1000, 0);
        if (result.kind === "grid") {
          set({ page: result, sqlResult: null });
          return;
        }
      }
    }
    const page = await ipc.rowList(tableId, 1000, 0);
    set({ page, sqlResult: null });
  }

  /**
   * Activate a table: every table always shows a view — if it has no grid
   * view yet, a default one is created (Notion-style).
   */
  async function activateTable(tableId: string) {
    const columns = await ipc.columnList(tableId);
    let views = await ipc.viewList(tableId);
    set({ activeTableId: tableId, columns, views, searchQuery: "" });
    let gridViews = views.filter((v) => v.kind === "grid");
    if (gridViews.length === 0) {
      const created = await ipc.viewCreate({
        table_id: tableId,
        name: "默认视图",
        kind: "grid",
        config: { kind: "grid", ...defaultGridConfig() },
      } satisfies NewView);
      views = await ipc.viewList(tableId);
      set({ views });
      gridViews = views.filter((v) => v.kind === "grid");
      void created;
    }
    await loadTableData(tableId, gridViews[0]?.id ?? null);
  }

  async function afterWrite() {
    const { activeTableId, activeViewId } = get();
    if (activeTableId) await loadTableData(activeTableId, activeViewId);
  }

  return {
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
          views: [],
          page: null,
          sqlResult: null,
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
          views: [],
          page: null,
          sqlResult: null,
          searchQuery: "",
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
          views: [],
          activeViewId: null,
          page: null,
          sqlResult: null,
          searchQuery: "",
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
        const tables = await ipc.tableList();
        set({ tables });
        await afterWrite();
      });
    },

    createTable: async (name, columns) => {
      await guard(set, get, async () => {
        const t = await ipc.tableCreate(name, columns);
        const tables = await ipc.tableList();
        set({ tables });
        await activateTable(t.id);
      });
    },

    deleteTable: async (id) => {
      await guard(set, get, async () => {
        await ipc.tableDelete(id);
        const tables = await ipc.tableList();
        set({ tables });
        const { activeTableId } = get();
        if (activeTableId === id) {
          const next = tables[0]?.id ?? null;
          set({ activeTableId: next, page: null, sqlResult: null, columns: [], views: [] });
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
        await afterWrite();
      });
    },

    updateColumn: async (colId, patch) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.columnUpdate(activeTableId, colId, patch);
        await afterWrite();
      });
    },

    deleteColumn: async (colId) => {
      await guard(set, get, async () => {
        const { activeTableId } = get();
        if (!activeTableId) return;
        await ipc.columnDelete(activeTableId, colId);
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
          const views = await ipc.viewList(activeTableId);
          set({ views, activeViewId: v.id });
        }
        const result = await ipc.viewRun(v.id, 1000, 0);
        if (result.kind === "sql") set({ sqlResult: result, page: null });
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
          // fall back to the first remaining grid view (auto-created if none)
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
        const { activeTableId } = get();
        if (!activeTableId) return;
        const updated = await ipc.rowUpdate(activeTableId, rid, { [colId]: value });
        // Patch the row in place — no full reload (formula cells come back
        // from the server, so generated values stay correct).
        const page = get().page;
        if (page) {
          set({
            page: {
              ...page,
              rows: page.rows.map((r) => (r.rid === rid ? { ...r, ...updated } : r)),
            },
          });
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
        const page = await ipc.search(activeTableId, query, 1000, 0);
        set({ page, sqlResult: null, searchQuery: query });
      });
    },
  };
});

// Re-export for components that build configs.
export type { GridConfig, ViewConfig };
