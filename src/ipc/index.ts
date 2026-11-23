// The ONLY module allowed to talk to the Rust backend (AGENTS.md).
// Components and stores import from here; direct `invoke` elsewhere is banned.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import type {
  AppInfo,
  Cells,
  ColumnMeta,
  ColumnPatch,
  CommandError,
  CsvPreview,
  ImportCsvOptions,
  ImportReport,
  NewColumn,
  NewView,
  Row,
  RowPage,
  SettingsView,
  SqlResult,
  TableMeta,
  ViewColumnMeta,
  ViewColumnPatch,
  ViewMeta,
  ViewPatch,
  ViewResult,
  WorkspaceInfo,
  WorkspaceUiState,
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

// ---- build metadata ----

export const appInfo = () => call<AppInfo>("app_info");

// ---- app settings & shell open requests ----

export const settingsGet = () => call<SettingsView>("settings_get");

export const settingsUi = (path: string) => call<WorkspaceUiState | null>("settings_ui", { path });

export const settingsSetUi = (path: string, tableId: string | null, viewId: string | null) =>
  call<void>("settings_set_ui", { path, tableId, viewId });

/** Take (and clear) a `.nothing` path queued by the shell. */
export const takeOpenRequest = () => call<string | null>("take_open_request");

/** Subscribe to `.nothing` files opened while the app is running. */
export function onOpenRequest(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("open-request", (event) => handler(event.payload));
}

// ---- tables & columns ----

export const tableList = () => call<TableMeta[]>("table_list");

export const tableCreate = (name: string, columns: NewColumn[], icon?: string | null) =>
  call<TableMeta>("table_create", { name, columns, icon: icon ?? null });

export const tableRename = (tableId: string, newName: string) =>
  call<TableMeta>("table_rename", { tableId, newName });

export const tableDelete = (tableId: string) =>
  call<void>("table_delete", { tableId });

export const tableSetTitle = (tableId: string, colId: string) =>
  call<TableMeta>("table_set_title", { tableId, colId });

export const tableSetIcon = (tableId: string, icon: string | null) =>
  call<TableMeta>("table_set_icon", { tableId, icon });

export const tableSetColor = (tableId: string, color: string | null) =>
  call<TableMeta>("table_set_color", { tableId, color });

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

export const viewColumnUpdate = (
  viewId: string,
  columnId: string,
  patch: Omit<ViewColumnPatch, "column_id"> & { column_id?: string },
) => call<ViewColumnMeta>("view_column_update", { viewId, columnId, patch });

export const viewRun = (viewId: string, limit?: number, offset?: number) =>
  call<ViewResult>("view_run", { viewId, limit, offset });

export const search = (tableId: string, query: string, limit?: number, offset?: number) =>
  call<RowPage>("search", { tableId, query, limit, offset });

export const runSql = (sql: string, limit?: number, offset?: number) =>
  call<SqlResult>("run_sql", { sql, limit, offset });

// ---- CSV import ----

export const csvPreview = (path: string, previewRows?: number) =>
  call<CsvPreview>("csv_preview", { path, previewRows });

export const csvImport = (options: ImportCsvOptions) =>
  call<ImportReport>("csv_import", { options });

// ---- native dialogs ----

export async function pickWorkspaceFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: t("welcome.workspaceFile"), extensions: ["nothing"] }],
    title: t("welcome.openTab"),
  });
  return typeof picked === "string" ? picked : null;
}

export async function pickNewWorkspacePath(): Promise<string | null> {
  const picked = await save({
    filters: [{ name: t("welcome.workspaceFile"), extensions: ["nothing"] }],
    title: t("welcome.createTab"),
  });
  if (typeof picked !== "string") return null;
  return picked.endsWith(".nothing") ? picked : `${picked}.nothing`;
}

export async function pickCsvFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: t("importCsv.fileType"), extensions: ["csv", "tsv", "txt"] }],
    title: t("importCsv.pickTitle"),
  });
  return typeof picked === "string" ? picked : null;
}
