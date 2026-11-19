// Global workspace state. All backend calls go through src/ipc (AGENTS.md);
// errors are caught here and surfaced via `error` for the toast component.

import { create } from "zustand";
import * as ipc from "../ipc";
import type {
  Cells,
  ColumnMeta,
  ColumnPatch,
  Json,
  NewColumn,
  RowPage,
  SqlResult,
  TableMeta,
  ViewMeta,
  WorkspaceInfo,
} from "../types";

interface WorkspaceState {
  info: WorkspaceInfo | null;
  tables: TableMeta[];
  activeTableId: string | null;
  columns: ColumnMeta[];
  views: ViewMeta[];
  /** null = showing the raw table; otherwise the selected view. */
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
  addColumn: (col: NewColumn) => Promise<void>;
  updateColumn: (colId: string, patch: ColumnPatch) => Promise<void>;
  deleteColumn: (colId: string) => Promise<void>;

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
  /** Load columns + views + first page for the active table. */
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
      const result = await ipc.viewRun(viewId, 1000, 0);
      if (result.kind === "grid") {
        set({ page: result, sqlResult: null });
        return;
      }
    }
    const page = await ipc.rowList(tableId, 1000, 0);
    set({ page, sqlResult: null });
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
        set({ info, tables, activeTableId: null, columns: [], views: [], page: null, sqlResult: null });
        if (tables.length > 0) {
          set({ activeTableId: tables[0].id });
          await loadTableData(tables[0].id, null);
        }
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
        });
      });
    },

    changePassword: async (pw) => {
      await guard(set, get, () => ipc.workspaceChangePassword(pw));
    },

    selectTable: async (id) => {
      await guard(set, get, async () => {
        set({ activeTableId: id });
        await loadTableData(id, null);
      });
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
        set({ tables, activeTableId: t.id });
        await loadTableData(t.id, null);
      });
    },

    deleteTable: async (id) => {
      await guard(set, get, async () => {
        await ipc.tableDelete(id);
        const tables = await ipc.tableList();
        const next = get().activeTableId === id ? (tables[0]?.id ?? null) : get().activeTableId;
        set({ tables, activeTableId: next, page: null, columns: [], views: [] });
        if (next) await loadTableData(next, null);
      });
    },

    renameTable: async (id, name) => {
      await guard(set, get, async () => {
        await ipc.tableRename(id, name);
        set({ tables: await ipc.tableList() });
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
