// The ONLY module allowed to talk to the Rust backend (AGENTS.md).
// Components and stores import from here; direct `invoke` elsewhere is banned.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  Cells,
  ColumnMeta,
  ColumnPatch,
  CommandError,
  NewColumn,
  NewView,
  Row,
  RowPage,
  SqlResult,
  TableMeta,
  ViewMeta,
  ViewPatch,
  ViewResult,
  WorkspaceInfo,
} from "../types";

/** Error thrown by every ipc call; `kind` mirrors the Rust AppError variant. */
export class IpcError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = e as CommandError;
    if (err && typeof err === "object" && "message" in err) {
      throw new IpcError(err.kind ?? "Unknown", err.message);
    }
    throw new IpcError("Unknown", String(e));
  }
}

// ---- workspace ----

export const workspaceCreate = (path: string, password: string) =>
  call<WorkspaceInfo>("workspace_create", { path, password });

export const workspaceOpen = (path: string, password: string) =>
  call<WorkspaceInfo>("workspace_open", { path, password });

export const workspaceClose = () => call<void>("workspace_close");

export const workspaceInfo = () => call<WorkspaceInfo | null>("workspace_info");

export const workspaceChangePassword = (newPassword: string) =>
  call<void>("workspace_change_password", { newPassword });

// ---- tables & columns ----

export const tableList = () => call<TableMeta[]>("table_list");

export const tableCreate = (name: string, columns: NewColumn[]) =>
  call<TableMeta>("table_create", { name, columns });

export const tableRename = (tableId: string, newName: string) =>
  call<TableMeta>("table_rename", { tableId, newName });

export const tableDelete = (tableId: string) =>
  call<void>("table_delete", { tableId });

export const tableSetTitle = (tableId: string, colId: string) =>
  call<TableMeta>("table_set_title", { tableId, colId });

export const columnList = (tableId: string) =>
  call<ColumnMeta[]>("column_list", { tableId });

export const columnAdd = (tableId: string, col: NewColumn) =>
  call<ColumnMeta>("column_add", { tableId, col });

export const columnUpdate = (tableId: string, colId: string, patch: ColumnPatch) =>
  call<ColumnMeta>("column_update", { tableId, colId, patch });

export const columnDelete = (tableId: string, colId: string) =>
  call<void>("column_delete", { tableId, colId });

// ---- rows ----

export const rowList = (tableId: string, limit?: number, offset?: number) =>
  call<RowPage>("row_list", { tableId, limit, offset });

export const rowGet = (tableId: string, rid: string) =>
  call<Row>("row_get", { tableId, rid });

export const rowInsert = (tableId: string, cells: Cells) =>
  call<Row>("row_insert", { tableId, cells });

export const rowUpdate = (tableId: string, rid: string, cells: Cells) =>
  call<Row>("row_update", { tableId, rid, cells });

export const rowBatchUpdate = (tableId: string, updates: [string, Cells][]) =>
  call<number>("row_batch_update", { tableId, updates });

export const rowDelete = (tableId: string, rids: string[]) =>
  call<number>("row_delete", { tableId, rids });

// ---- views, search, ad-hoc SQL ----

export const viewList = (tableId?: string | null) =>
  call<ViewMeta[]>("view_list", { tableId: tableId ?? null });

export const viewCreate = (view: NewView) => call<ViewMeta>("view_create", { view });

export const viewUpdate = (viewId: string, patch: ViewPatch) =>
  call<ViewMeta>("view_update", { viewId, patch });

export const viewDelete = (viewId: string) => call<void>("view_delete", { viewId });

export const viewRun = (viewId: string, limit?: number, offset?: number) =>
  call<ViewResult>("view_run", { viewId, limit, offset });

export const search = (tableId: string, query: string, limit?: number, offset?: number) =>
  call<RowPage>("search", { tableId, query, limit, offset });

export const runSql = (sql: string, limit?: number, offset?: number) =>
  call<SqlResult>("run_sql", { sql, limit, offset });

// ---- native dialogs ----

export async function pickWorkspaceFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "nothing 工作区", extensions: ["nothing"] }],
    title: "打开工作区",
  });
  return typeof picked === "string" ? picked : null;
}

export async function pickNewWorkspacePath(): Promise<string | null> {
  const picked = await save({
    filters: [{ name: "nothing 工作区", extensions: ["nothing"] }],
    title: "新建工作区",
  });
  if (typeof picked !== "string") return null;
  return picked.endsWith(".nothing") ? picked : `${picked}.nothing`;
}
