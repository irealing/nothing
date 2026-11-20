//! Tauri commands — a thin forwarding layer over `nothing_core` (AGENTS.md:
//! validation + error mapping only, no business logic here).

use std::sync::Mutex;

use nothing_core::{
    Cells, ColumnMeta, ColumnPatch, CsvPreview, ImportCsvOptions, ImportReport, NewColumn, NewView,
    Row, RowPage, SqlResult, TableMeta, ViewMeta, ViewPatch, ViewResult, Workspace,
};
use serde::Serialize;
use tauri::State;

use crate::settings;

#[derive(Default)]
pub struct AppState {
    /// The single open workspace (one window = one `.nothing` file in M3).
    ws: Mutex<Option<Workspace>>,
    /// A `.nothing` path handed to us by the shell (file association, drag onto
    /// the executable, or a second instance). Drained by the frontend so an
    /// already-open window can offer to switch.
    pending_open: Mutex<Option<String>>,
}

impl AppState {
    pub fn queue_open(&self, path: String) {
        if let Ok(mut slot) = self.pending_open.lock() {
            *slot = Some(path);
        }
    }
}

/// Structured error for the frontend (`kind` for branching, `message` is
/// user-facing Chinese text produced by the core).
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub kind: String,
    pub message: String,
}

impl CommandError {
    fn internal(msg: impl Into<String>) -> Self {
        Self {
            kind: "Internal".into(),
            message: msg.into(),
        }
    }
}

impl From<nothing_core::AppError> for CommandError {
    fn from(e: nothing_core::AppError) -> Self {
        let kind = match &e {
            nothing_core::AppError::WrongPassword => "WrongPassword",
            nothing_core::AppError::NotANothingDb => "NotANothingDb",
            nothing_core::AppError::FormatTooNew(_) => "FormatTooNew",
            nothing_core::AppError::NotFound(_) => "NotFound",
            nothing_core::AppError::AlreadyExists(_) => "AlreadyExists",
            nothing_core::AppError::InvalidInput(_) => "InvalidInput",
            nothing_core::AppError::Rejected(_) => "Rejected",
            nothing_core::AppError::Io(_) => "Io",
            nothing_core::AppError::Sqlite(_) => "Sqlite",
            nothing_core::AppError::Json(_) => "Json",
            nothing_core::AppError::Internal(_) => "Internal",
        };
        Self {
            kind: kind.into(),
            message: e.to_string(),
        }
    }
}

type CmdResult<T> = Result<T, CommandError>;

fn with_ws<R>(
    state: &AppState,
    f: impl FnOnce(&Workspace) -> nothing_core::error::Result<R>,
) -> CmdResult<R> {
    let guard = state
        .ws
        .lock()
        .map_err(|_| CommandError::internal("工作区状态锁已损坏"))?;
    let ws = guard.as_ref().ok_or_else(|| CommandError {
        kind: "NoWorkspace".into(),
        message: "尚未打开工作区".into(),
    })?;
    f(ws).map_err(CommandError::from)
}

fn store_ws(state: &AppState, ws: Workspace) -> CmdResult<()> {
    let mut guard = state
        .ws
        .lock()
        .map_err(|_| CommandError::internal("工作区状态锁已损坏"))?;
    *guard = Some(ws);
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub path: String,
    pub format_version: u32,
}

#[tauri::command]
pub fn workspace_create(
    app: tauri::AppHandle,
    state: State<AppState>,
    path: String,
    password: String,
) -> CmdResult<WorkspaceInfo> {
    let ws = Workspace::create(&path, &password).map_err(CommandError::from)?;
    let info = WorkspaceInfo {
        path: ws.path().to_string_lossy().into_owned(),
        format_version: ws.format_version().map_err(CommandError::from)?,
    };
    settings::remember_path(&app, &info.path);
    store_ws(&state, ws)?;
    Ok(info)
}

#[tauri::command]
pub fn workspace_open(
    app: tauri::AppHandle,
    state: State<AppState>,
    path: String,
    password: String,
) -> CmdResult<WorkspaceInfo> {
    let ws = Workspace::open(&path, &password).map_err(CommandError::from)?;
    let info = WorkspaceInfo {
        path: ws.path().to_string_lossy().into_owned(),
        format_version: ws.format_version().map_err(CommandError::from)?,
    };
    // Recorded only on success, so a wrong password never reorders recents.
    settings::remember_path(&app, &info.path);
    store_ws(&state, ws)?;
    Ok(info)
}

#[tauri::command]
pub fn workspace_close(state: State<AppState>) -> CmdResult<()> {
    let mut guard = state
        .ws
        .lock()
        .map_err(|_| CommandError::internal("工作区状态锁已损坏"))?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn workspace_info(state: State<AppState>) -> CmdResult<Option<WorkspaceInfo>> {
    let guard = state
        .ws
        .lock()
        .map_err(|_| CommandError::internal("工作区状态锁已损坏"))?;
    match guard.as_ref() {
        Some(ws) => Ok(Some(WorkspaceInfo {
            path: ws.path().to_string_lossy().into_owned(),
            format_version: ws.format_version().map_err(CommandError::from)?,
        })),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn workspace_change_password(state: State<AppState>, new_password: String) -> CmdResult<()> {
    with_ws(&state, |ws| ws.change_password(&new_password))
}

// ---------------------------------------------------------------------------
// App settings (recent files, last table/view) & shell open requests
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get(app: tauri::AppHandle) -> CmdResult<settings::SettingsView> {
    Ok(settings::view(&app))
}

#[tauri::command]
pub fn settings_ui(app: tauri::AppHandle, path: String) -> CmdResult<Option<settings::UiState>> {
    Ok(settings::ui_for(&app, &path))
}

#[tauri::command]
pub fn settings_set_ui(
    app: tauri::AppHandle,
    path: String,
    table_id: Option<String>,
    view_id: Option<String>,
) -> CmdResult<()> {
    settings::set_ui(&app, &path, table_id, view_id);
    Ok(())
}

/// Take (and clear) a `.nothing` path queued by the shell.
#[tauri::command]
pub fn take_open_request(state: State<AppState>) -> CmdResult<Option<String>> {
    let mut guard = state
        .pending_open
        .lock()
        .map_err(|_| CommandError::internal("待打开文件状态锁已损坏"))?;
    Ok(guard.take())
}

// ---------------------------------------------------------------------------
// Tables & columns
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn table_list(state: State<AppState>) -> CmdResult<Vec<TableMeta>> {
    with_ws(&state, |ws| ws.list_tables())
}

#[tauri::command]
pub fn table_create(
    state: State<AppState>,
    name: String,
    columns: Vec<NewColumn>,
    icon: Option<String>,
) -> CmdResult<TableMeta> {
    if columns.is_empty() {
        return Err(CommandError::from(nothing_core::AppError::InvalidInput(
            "表至少需要一列".into(),
        )));
    }
    with_ws(&state, |ws| {
        ws.create_table_with_icon(&name, columns, icon.as_deref())
    })
}

#[tauri::command]
pub fn table_rename(
    state: State<AppState>,
    table_id: String,
    new_name: String,
) -> CmdResult<TableMeta> {
    with_ws(&state, |ws| ws.rename_table(&table_id, &new_name))
}

#[tauri::command]
pub fn table_delete(state: State<AppState>, table_id: String) -> CmdResult<()> {
    with_ws(&state, |ws| ws.delete_table(&table_id))
}

#[tauri::command]
pub fn table_set_title(
    state: State<AppState>,
    table_id: String,
    col_id: String,
) -> CmdResult<TableMeta> {
    with_ws(&state, |ws| ws.set_title_column(&table_id, &col_id))
}

#[tauri::command]
pub fn table_set_icon(
    state: State<AppState>,
    table_id: String,
    icon: Option<String>,
) -> CmdResult<TableMeta> {
    with_ws(&state, |ws| ws.set_table_icon(&table_id, icon.as_deref()))
}

#[tauri::command]
pub fn column_list(state: State<AppState>, table_id: String) -> CmdResult<Vec<ColumnMeta>> {
    with_ws(&state, |ws| ws.list_columns(&table_id))
}

#[tauri::command]
pub fn column_add(
    state: State<AppState>,
    table_id: String,
    col: NewColumn,
) -> CmdResult<ColumnMeta> {
    with_ws(&state, |ws| ws.add_column(&table_id, col))
}

#[tauri::command]
pub fn column_update(
    state: State<AppState>,
    table_id: String,
    col_id: String,
    patch: ColumnPatch,
) -> CmdResult<ColumnMeta> {
    with_ws(&state, |ws| ws.update_column(&table_id, &col_id, patch))
}

#[tauri::command]
pub fn column_delete(state: State<AppState>, table_id: String, col_id: String) -> CmdResult<()> {
    with_ws(&state, |ws| ws.delete_column(&table_id, &col_id))
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn row_list(
    state: State<AppState>,
    table_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> CmdResult<RowPage> {
    with_ws(&state, |ws| ws.list_rows(&table_id, limit, offset))
}

#[tauri::command]
pub fn row_get(state: State<AppState>, table_id: String, rid: String) -> CmdResult<Row> {
    with_ws(&state, |ws| ws.get_row(&table_id, &rid))
}

#[tauri::command]
pub fn row_insert(state: State<AppState>, table_id: String, cells: Cells) -> CmdResult<Row> {
    with_ws(&state, |ws| ws.insert_row(&table_id, cells))
}

#[tauri::command]
pub fn row_update(
    state: State<AppState>,
    table_id: String,
    rid: String,
    cells: Cells,
) -> CmdResult<Row> {
    with_ws(&state, |ws| ws.update_row(&table_id, &rid, cells))
}

#[tauri::command]
pub fn row_batch_update(
    state: State<AppState>,
    table_id: String,
    updates: Vec<(String, Cells)>,
) -> CmdResult<usize> {
    with_ws(&state, |ws| ws.batch_update(&table_id, updates))
}

#[tauri::command]
pub fn row_delete(state: State<AppState>, table_id: String, rids: Vec<String>) -> CmdResult<usize> {
    with_ws(&state, |ws| ws.delete_rows(&table_id, &rids))
}

// ---------------------------------------------------------------------------
// Views, search, ad-hoc SQL
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn view_list(state: State<AppState>, table_id: Option<String>) -> CmdResult<Vec<ViewMeta>> {
    with_ws(&state, |ws| ws.list_views(table_id.as_deref()))
}

#[tauri::command]
pub fn view_create(state: State<AppState>, view: NewView) -> CmdResult<ViewMeta> {
    with_ws(&state, |ws| ws.create_view(view))
}

#[tauri::command]
pub fn view_update(
    state: State<AppState>,
    view_id: String,
    patch: ViewPatch,
) -> CmdResult<ViewMeta> {
    with_ws(&state, |ws| ws.update_view(&view_id, patch))
}

#[tauri::command]
pub fn view_delete(state: State<AppState>, view_id: String) -> CmdResult<()> {
    with_ws(&state, |ws| ws.delete_view(&view_id))
}

#[tauri::command]
pub fn view_run(
    state: State<AppState>,
    view_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> CmdResult<ViewResult> {
    with_ws(&state, |ws| ws.run_view(&view_id, limit, offset))
}

#[tauri::command]
pub fn search(
    state: State<AppState>,
    table_id: String,
    query: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> CmdResult<RowPage> {
    with_ws(&state, |ws| ws.search(&table_id, &query, limit, offset))
}

#[tauri::command]
pub fn run_sql(
    state: State<AppState>,
    sql: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> CmdResult<SqlResult> {
    with_ws(&state, |ws| ws.run_sql(&sql, limit, offset))
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn csv_preview(path: String, preview_rows: Option<usize>) -> CmdResult<CsvPreview> {
    nothing_core::read_csv_preview(&path, preview_rows.unwrap_or(20)).map_err(CommandError::from)
}

#[tauri::command]
pub fn csv_import(state: State<AppState>, options: ImportCsvOptions) -> CmdResult<ImportReport> {
    with_ws(&state, |ws| ws.import_csv(options))
}
