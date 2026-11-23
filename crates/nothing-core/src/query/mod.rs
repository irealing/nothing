//! Query layer: row CRUD, the grid-view SQL compiler, FTS search, read-only
//! SQL view execution, and batched relation-title resolution.
//!
//! All generated SQL is either metadata-derived (identifiers) or parameter
//! bound (values) — 铁律 4. All user-facing reads run on the workspace's
//! dedicated `query_only` connection.

pub(crate) mod compiler;
pub(crate) mod rows;
pub(crate) mod run;

pub use run::ViewResult;

use std::collections::HashMap;

use rusqlite::types::ValueRef;
use serde::Serialize;

use crate::error::{AppError, Result};
use crate::schema::{ColumnMeta, ColumnType};

/// Cell values keyed by column id.
pub type Cells = HashMap<String, serde_json::Value>;

/// One table row: identity, timestamps and cells keyed by column id.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    pub rid: String,
    pub created: String,
    pub updated: String,
    pub cells: Cells,
}

/// A page of rows plus everything the grid UI needs to render it.
#[derive(Debug, Clone, Serialize)]
pub struct RowPage {
    /// Visible columns in display order (includes relation/formula columns).
    /// `ColumnMeta::width` is the effective width in this view.
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Row>,
    /// Total rows matching the view (for pagination).
    pub total: i64,
    /// rid → title for every row referenced by a relation cell on this page
    /// (batch-resolved; the frontend must never fetch these one by one).
    pub titles: HashMap<String, String>,
}

/// Column descriptor of an ad-hoc SQL result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SqlColumn {
    pub name: String,
    pub decl_type: Option<String>,
}

/// Result of a SQL view / ad-hoc query: raw columnar values.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SqlResult {
    pub columns: Vec<SqlColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

/// Hard caps for page sizes coming over IPC.
pub const MAX_LIMIT: i64 = 2_000;
pub const DEFAULT_LIMIT: i64 = 200;

pub(crate) fn clamp_pagination(limit: Option<i64>, offset: Option<i64>) -> (i64, i64) {
    (
        limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        offset.unwrap_or(0).max(0),
    )
}

// ---------------------------------------------------------------------------
// Value conversions
// ---------------------------------------------------------------------------

/// Generic SQLite value → JSON (ad-hoc SQL results; BLOBs become
/// `base64:<...>` strings).
pub(crate) fn valueref_to_json(v: ValueRef<'_>) -> serde_json::Value {
    use base64::Engine;
    match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::json!(f),
        ValueRef::Text(t) => serde_json::Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::Value::from(format!(
            "base64:{}",
            base64::engine::general_purpose::STANDARD.encode(b)
        )),
    }
}

/// Convert a JSON input value to the SQLite storage form of a column type.
///
/// Returns `Ok(None)` when the value must be stored via a side channel
/// (relation columns → junction table) rather than a physical column.
pub(crate) fn json_to_stored(
    col: &ColumnMeta,
    value: &serde_json::Value,
) -> Result<Option<rusqlite::types::Value>> {
    use rusqlite::types::Value;

    let col_type = col.col_type();
    if col_type == ColumnType::Formula {
        return Err(AppError::Rejected(format!(
            "公式列「{}」由数据库自动计算，不能手动写入",
            col.name
        )));
    }
    if col_type == ColumnType::Relation {
        // Handled via the junction table by the caller.
        validate_rid_list(col, value)?;
        return Ok(None);
    }

    Ok(Some(match col_type {
        ColumnType::Text => match value {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::String(s) => Value::Text(s.clone()),
            serde_json::Value::Number(n) => Value::Text(n.to_string()),
            _ => invalid_cell(col, value)?,
        },
        ColumnType::Number => match value {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Number(n) => Value::Real(n.as_f64().unwrap_or(0.0)),
            serde_json::Value::String(s) => match s.trim().parse::<f64>() {
                Ok(f) => Value::Real(f),
                Err(_) => invalid_cell(col, value)?,
            },
            _ => invalid_cell(col, value)?,
        },
        ColumnType::Checkbox => match value {
            serde_json::Value::Bool(b) => Value::Integer(*b as i64),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(0) => Value::Integer(0),
                Some(1) => Value::Integer(1),
                _ => invalid_cell(col, value)?,
            },
            serde_json::Value::String(s) => match s.as_str() {
                "true" => Value::Integer(1),
                "false" => Value::Integer(0),
                _ => invalid_cell(col, value)?,
            },
            _ => invalid_cell(col, value)?,
        },
        ColumnType::Date => match value {
            serde_json::Value::Null => Value::Null,
            // The table's CHECK(datetime(...) IS NOT NULL) enforces validity.
            serde_json::Value::String(s) => Value::Text(s.clone()),
            _ => invalid_cell(col, value)?,
        },
        ColumnType::Select => match value {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::String(s) => {
                validate_choice(col, s)?;
                Value::Text(s.clone())
            }
            _ => invalid_cell(col, value)?,
        },
        ColumnType::MultiSelect => match value {
            serde_json::Value::Null => Value::Text("[]".into()),
            serde_json::Value::Array(items) => {
                let mut names = Vec::with_capacity(items.len());
                for it in items {
                    let s = it.as_str().ok_or_else(|| {
                        AppError::InvalidInput(format!(
                            "多选列「{}」的值必须是字符串数组",
                            col.name
                        ))
                    })?;
                    validate_choice(col, s)?;
                    names.push(s.to_string());
                }
                Value::Text(serde_json::to_string(&names)?)
            }
            _ => invalid_cell(col, value)?,
        },
        ColumnType::Formula | ColumnType::Relation => unreachable!(),
    }))
}

fn validate_choice(col: &ColumnMeta, name: &str) -> Result<()> {
    let choices = col.choices();
    if choices.is_empty() || choices.iter().any(|c| c.name == name) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "「{}」不是列「{}」的有效选项",
            name, col.name
        )))
    }
}

fn validate_rid_list(col: &ColumnMeta, value: &serde_json::Value) -> Result<()> {
    let single = col
        .relation()
        .map(|r| r.single)
        .ok_or_else(|| AppError::Internal("关联列缺少关联数据".into()))?;
    match value {
        serde_json::Value::Null => Ok(()),
        serde_json::Value::Array(items) => {
            for it in items {
                if !it.is_string() {
                    return Err(AppError::InvalidInput(format!(
                        "关联列「{}」的值必须是行 ID 字符串数组",
                        col.name
                    )));
                }
            }
            if single && items.len() > 1 {
                return Err(AppError::InvalidInput(format!(
                    "关联列「{}」只允许关联一行",
                    col.name
                )));
            }
            Ok(())
        }
        _ => invalid_cell(col, value).map(|_| ()),
    }
}

fn invalid_cell(col: &ColumnMeta, value: &serde_json::Value) -> Result<rusqlite::types::Value> {
    Err(AppError::InvalidInput(format!(
        "列「{}」（{}）不接受该值: {}",
        col.name,
        col.col_type().as_str(),
        value
    )))
}

/// Decode a stored SQLite value into the JSON cell form of a column type.
pub(crate) fn stored_to_json(col: &ColumnMeta, v: ValueRef<'_>) -> Result<serde_json::Value> {
    let effective = col.effective_type();
    Ok(match (effective, v) {
        (_, ValueRef::Null) => match effective {
            ColumnType::MultiSelect => serde_json::json!([]),
            _ => serde_json::Value::Null,
        },
        (ColumnType::Checkbox, ValueRef::Integer(i)) => serde_json::json!(i != 0),
        (ColumnType::Number, ValueRef::Integer(i)) => serde_json::json!(i as f64),
        (ColumnType::Number, ValueRef::Real(f)) => serde_json::json!(f),
        (ColumnType::MultiSelect, ValueRef::Text(t)) => {
            let s = String::from_utf8_lossy(t);
            serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!([]))
        }
        (_, ValueRef::Text(t)) => serde_json::Value::from(String::from_utf8_lossy(t).into_owned()),
        // Unexpected physical shapes fall back to the generic conversion.
        (_, other) => valueref_to_json(other),
    })
}
