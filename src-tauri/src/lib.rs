//! Tauri shell for nothing.
//!
//! Thin by design (AGENTS.md): commands validate parameters, forward to
//! `nothing_core`, and map errors. All logic lives in the core crate; the only
//! shell-level logic is `settings` (recent files / last table-view) and the
//! command-line plumbing for the installed `.nothing` file association.

mod commands;
mod settings;

use commands::AppState;
use tauri::{Emitter, Manager};

/// Emitted when a running instance is asked to open another workspace file.
const OPEN_REQUEST_EVENT: &str = "open-request";

/// The `.nothing` path passed on a cold start, if any.
fn startup_path() -> Option<String> {
    settings::pick_workspace_arg(std::env::args_os().map(|a| a.to_string_lossy().into_owned()))
}

pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered so it wins the race against the
        // rest of the setup for the second instance's arguments.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = settings::pick_workspace_arg(args) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.queue_open(path.clone());
                }
                let _ = app.emit(OPEN_REQUEST_EVENT, path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            if let Some(path) = startup_path() {
                app.state::<AppState>().queue_open(path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // workspace
            commands::workspace_create,
            commands::workspace_open,
            commands::workspace_close,
            commands::workspace_change_password,
            // build metadata
            commands::app_info,
            // app settings & shell open requests
            commands::settings_get,
            commands::settings_ui,
            commands::settings_set_ui,
            commands::take_open_request,
            // tables
            commands::table_list,
            commands::table_create,
            commands::table_rename,
            commands::table_delete,
            commands::table_set_title,
            commands::table_set_icon,
            commands::table_set_color,
            // columns
            commands::column_list,
            commands::column_add,
            commands::column_update,
            commands::column_delete,
            // rows
            commands::row_list,
            commands::row_get,
            commands::row_insert,
            commands::row_update,
            commands::row_batch_update,
            commands::row_delete,
            // views
            commands::view_list,
            commands::view_create,
            commands::view_update,
            commands::view_delete,
            commands::view_column_update,
            commands::view_run,
            // search & ad-hoc SQL
            commands::search,
            commands::run_sql,
            // CSV import
            commands::csv_preview,
            commands::csv_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nothing");
}
