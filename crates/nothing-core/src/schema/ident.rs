//! Identifier helpers: ULID ids, generated physical names, and the only two
//! sanctioned SQL-escaping primitives (铁律 4).
//!
//! Physical object names are always generated from ULIDs — user-provided text
//! never becomes an identifier. The two quoting helpers below are the single
//! place where values are embedded into DDL/DML strings; everything else uses
//! parameter binding.

use ulid::Ulid;

use crate::error::{AppError, Result};

/// Generate a new ULID id (used for tables, columns, rows and views).
pub fn new_id() -> String {
    Ulid::new().to_string()
}

/// Physical table name for a table id: `t_<ulid lowercase>`.
pub fn table_sql_name(table_id: &str) -> String {
    format!("t_{}", table_id.to_ascii_lowercase())
}

/// Physical column name for a column id: `c_<ulid lowercase>`.
///
/// Stable for the column's whole lifetime — UI renames never touch it
/// (铁律 3).
pub fn column_sql_name(column_id: &str) -> String {
    format!("c_{}", column_id.to_ascii_lowercase())
}

/// Junction table name for a relation column id: `r_<ulid lowercase>`.
pub fn junction_sql_name(column_id: &str) -> String {
    format!("r_{}", column_id.to_ascii_lowercase())
}

/// Reverse-index name for a junction table: `r_<ulid lowercase>_rev`.
pub fn junction_index_name(column_id: &str) -> String {
    format!("{}_rev", junction_sql_name(column_id))
}

/// Physical SQL view name for a view id: `v_<ulid lowercase>`.
pub fn view_sql_name(view_id: &str) -> String {
    format!("v_{}", view_id.to_ascii_lowercase())
}

/// Quote a SQL identifier (double quotes, embedded quotes doubled).
///
/// Only ever called with generated names (`t_/c_/r_/v_` + ULID) and fixed
/// internal names — never with raw user input.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quote a SQL string literal (single quotes, embedded quotes doubled).
///
/// This is the sanctioned escaping primitive for embedding user-provided
/// *data* (e.g. select choice names) into DDL templates such as CHECK
/// constraints, where parameter binding is not possible. NUL bytes cannot be
/// represented in SQLite text and are rejected (name validation normally
/// catches them earlier).
pub fn quote_literal(value: &str) -> Result<String> {
    if value.contains('\0') {
        return Err(AppError::InvalidInput("值不能包含 NUL 字符".into()));
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

/// Validate and normalize a user-facing name (table/column/view).
pub fn validate_user_name(kind: &str, name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput(format!("{kind}不能为空")));
    }
    if name.chars().count() > 128 {
        return Err(AppError::InvalidInput(format!(
            "{kind}过长（最多 128 字符）"
        )));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::InvalidInput(format!("{kind}不能包含控制字符")));
    }
    Ok(name.to_string())
}

/// Current UTC time as an ISO8601 string with millisecond precision.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
