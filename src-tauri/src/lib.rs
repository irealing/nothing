//! Tauri shell for nothing.
//!
//! Thin by design (AGENTS.md): commands validate parameters, forward to
//! `nothing_core`, and map errors. All logic lives in the core crate.

mod commands;

use commands::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            // workspace
            commands::workspace_create,
            commands::workspace_open,
            commands::workspace_close,
            commands::workspace_info,
            commands::workspace_change_password,
            // tables
            commands::table_list,
            commands::table_create,
            commands::table_rename,
            commands::table_delete,
            commands::table_set_title,
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
            commands::view_run,
            // search & ad-hoc SQL
            commands::search,
            commands::run_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nothing");
}
