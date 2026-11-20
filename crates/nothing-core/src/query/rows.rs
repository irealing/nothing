//! Row CRUD on [`Workspace`].
//!
//! Writes go through the single writer connection inside one transaction
//! (铁律 1/9). Cell values are validated against column metadata, then bound
//! as parameters; constraint violations surface as friendly [`AppError`]s via
//! [`map_sqlite_err`]. Relation cells write to the junction table (FKs
//! enforce target existence and cascade cleanup).

use rusqlite::{Connection, OptionalExtension};

use super::{json_to_stored, Cells, Row};
use crate::db::Workspace;
use crate::error::{AppError, Result};
use crate::schema::ident::{junction_sql_name, new_id, now_iso, quote_ident};
use crate::schema::table::map_sqlite_err;
use crate::schema::{load_column, load_columns, load_table, ColumnMeta, TableMeta};

/// Chunk size for `IN (...)` lists (well below SQLite's variable limit).
pub(crate) const IN_CHUNK: usize = 500;

pub(crate) fn in_placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// One validated cell awaiting write: (column id, metadata, JSON value).
type CellEntry<'a> = (&'a String, &'a ColumnMeta, &'a serde_json::Value);

/// Split cells into (physical, relation) groups, validating column ids.
fn split_cells<'a>(
    cols: &'a [ColumnMeta],
    cells: &'a Cells,
) -> Result<(Vec<CellEntry<'a>>, Vec<CellEntry<'a>>)> {
    let by_id: std::collections::HashMap<&str, &ColumnMeta> =
        cols.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut physical = Vec::new();
    let mut relations = Vec::new();
    let mut ids: Vec<&String> = cells.keys().collect();
    ids.sort(); // deterministic SQL
    for id in ids {
        let col = by_id
            .get(id.as_str())
            .ok_or_else(|| AppError::NotFound(format!("列 {id}")))?;
        let value = &cells[id];
        // Validate every cell (including relation payloads) up front.
        json_to_stored(col, value)?;
        if col.col_type == crate::schema::ColumnType::Relation {
            relations.push((id, *col, value));
        } else {
            physical.push((id, *col, value));
        }
    }
    Ok((physical, relations))
}

/// Replace all links of one row for one relation column.
///
/// `side` is `"a"` for source columns and `"b"` for reverse columns; the
/// junction belongs to the *source* column in both cases.
fn replace_links(
    conn: &Connection,
    col: &ColumnMeta,
    row_rid: &str,
    value: &serde_json::Value,
) -> Result<()> {
    let source_col_id = if col.is_reverse {
        col.reverse_of
            .as_deref()
            .ok_or_else(|| AppError::Internal("反向列缺少 reverse_of".into()))?
    } else {
        col.id.as_str()
    };
    let junction = quote_ident(&junction_sql_name(source_col_id));
    let fixed_side = if col.is_reverse { "b" } else { "a" };

    // Deduplicate, preserve order.
    let mut targets: Vec<String> = Vec::new();
    if let serde_json::Value::Array(items) = value {
        for it in items {
            let s = it.as_str().unwrap_or_default().to_string();
            if !s.is_empty() && !targets.contains(&s) {
                targets.push(s);
            }
        }
    }

    // Pre-check targets exist so we can report NotFound instead of a raw FK
    // constraint message.
    if !targets.is_empty() {
        let target_table_id = &col.opts.relation()?.target_table_id;
        let target = crate::schema::load_table(conn, target_table_id)?;
        let mut remaining = targets.len();
        for chunk in targets.chunks(IN_CHUNK) {
            let sql = format!(
                r#"SELECT count(*) FROM {} WHERE "_rid" IN ({})"#,
                quote_ident(&target.sql_name),
                in_placeholders(chunk.len())
            );
            let found: i64 = conn
                .query_row(
                    &sql,
                    rusqlite::params_from_iter(chunk.iter().map(|s| s.as_str())),
                    |r| r.get(0),
                )
                .map_err(map_sqlite_err)?;
            remaining = remaining.saturating_sub(found as usize);
        }
        if remaining > 0 {
            return Err(AppError::NotFound(format!(
                "{} 个关联目标行不存在",
                remaining
            )));
        }
    }

    conn.execute(
        &format!(r#"DELETE FROM {junction} WHERE "{fixed_side}" = ?1"#),
        [row_rid],
    )
    .map_err(map_sqlite_err)?;
    for (ord, t) in targets.iter().enumerate() {
        let (a, b) = if fixed_side == "a" {
            (row_rid, t.as_str())
        } else {
            (t.as_str(), row_rid)
        };
        conn.execute(
            &format!(
                r#"INSERT INTO {junction} ("a", "b", "ord") VALUES (?1, ?2, ?3)
                   ON CONFLICT("a", "b") DO UPDATE SET "ord" = excluded."ord""#
            ),
            rusqlite::params![a, b, ord as i64],
        )
        .map_err(map_sqlite_err)?;
    }
    Ok(())
}

/// Physical INSERT/UPDATE of the non-relation cells.
fn write_physical(
    conn: &Connection,
    table: &TableMeta,
    physical: &[CellEntry],
    rid: &str,
    is_insert: bool,
    now: &str,
) -> Result<()> {
    let qtab = quote_ident(&table.sql_name);
    if is_insert {
        let mut cols_sql = vec![
            quote_ident("_rid"),
            quote_ident("_created"),
            quote_ident("_updated"),
        ];
        let mut params: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(rid.into()),
            rusqlite::types::Value::Text(now.into()),
            rusqlite::types::Value::Text(now.into()),
        ];
        for (_, col, value) in physical {
            if let Some(stored) = json_to_stored(col, value)? {
                cols_sql.push(quote_ident(&col.sql_name));
                params.push(stored);
            }
        }
        let sql = format!(
            "INSERT INTO {qtab} ({}) VALUES ({})",
            cols_sql.join(", "),
            in_placeholders(params.len())
        );
        conn.execute(&sql, rusqlite::params_from_iter(params.iter()))
            .map_err(map_sqlite_err)?;
    } else if !physical.is_empty() {
        let mut sets = Vec::new();
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        for (_, col, value) in physical {
            if let Some(stored) = json_to_stored(col, value)? {
                sets.push(format!("{} = ?", quote_ident(&col.sql_name)));
                params.push(stored);
            }
        }
        if sets.is_empty() {
            return Ok(());
        }
        sets.push(format!("{} = ?", quote_ident("_updated")));
        params.push(rusqlite::types::Value::Text(now.into()));
        params.push(rusqlite::types::Value::Text(rid.into()));
        let sql = format!("UPDATE {qtab} SET {} WHERE \"_rid\" = ?", sets.join(", "));
        let n = conn
            .execute(&sql, rusqlite::params_from_iter(params.iter()))
            .map_err(map_sqlite_err)?;
        if n == 0 {
            return Err(AppError::NotFound(format!("行 {rid}")));
        }
    }
    Ok(())
}

/// Fill defaults for columns the caller did not provide. Formula columns are
/// generated and reverse relation columns are the other side of a link, so
/// neither can carry a default.
fn apply_defaults(cols: &[ColumnMeta], mut cells: Cells) -> Result<Cells> {
    for col in cols {
        if col.is_reverse || col.col_type == crate::schema::ColumnType::Formula {
            continue;
        }
        if cells.contains_key(&col.id) {
            continue;
        }
        let Some(default) = &col.default_value else {
            continue;
        };
        if default.is_null() {
            continue;
        }
        cells.insert(
            col.id.clone(),
            crate::schema::default_cell_value(col, default)?,
        );
    }
    Ok(cells)
}

impl Workspace {
    /// Insert one row; `cells` is keyed by column id (missing cells keep
    /// column defaults). Returns the stored row including relation cells.
    pub fn insert_row(&self, table_id: &str, cells: Cells) -> Result<Row> {
        let rid = new_id();
        let now = now_iso();
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let cols = load_columns(conn, table_id)?;
            let cells = apply_defaults(&cols, cells)?;
            let (physical, relations) = split_cells(&cols, &cells)?;
            write_physical(conn, &table, &physical, &rid, true, &now)?;
            for (_, col, value) in relations {
                replace_links(conn, col, &rid, value)?;
            }
            Ok(())
        })?;
        self.get_row(table_id, &rid)
    }

    /// Update one row's cells (partial). Returns the fresh row.
    pub fn update_row(&self, table_id: &str, rid: &str, cells: Cells) -> Result<Row> {
        let now = now_iso();
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let exists: bool = conn
                .query_row(
                    &format!(
                        r#"SELECT 1 FROM {} WHERE "_rid" = ?1"#,
                        quote_ident(&table.sql_name)
                    ),
                    [rid],
                    |_| Ok(true),
                )
                .optional()
                .map_err(map_sqlite_err)?
                .unwrap_or(false);
            if !exists {
                return Err(AppError::NotFound(format!("行 {rid}")));
            }
            let cols = load_columns(conn, table_id)?;
            let (physical, relations) = split_cells(&cols, &cells)?;
            write_physical(conn, &table, &physical, rid, false, &now)?;
            for (_, col, value) in relations {
                replace_links(conn, col, rid, value)?;
            }
            Ok(())
        })?;
        self.get_row(table_id, rid)
    }

    /// Update many rows in one transaction. Returns the number updated.
    pub fn batch_update(&self, table_id: &str, updates: Vec<(String, Cells)>) -> Result<usize> {
        let now = now_iso();
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let cols = load_columns(conn, table_id)?;
            let mut n = 0;
            for (rid, cells) in &updates {
                let exists: bool = conn
                    .query_row(
                        &format!(
                            r#"SELECT 1 FROM {} WHERE "_rid" = ?1"#,
                            quote_ident(&table.sql_name)
                        ),
                        [rid],
                        |_| Ok(true),
                    )
                    .optional()
                    .map_err(map_sqlite_err)?
                    .unwrap_or(false);
                if !exists {
                    return Err(AppError::NotFound(format!("行 {rid}")));
                }
                let (physical, relations) = split_cells(&cols, cells)?;
                write_physical(conn, &table, &physical, rid, false, &now)?;
                for (_, col, value) in relations {
                    replace_links(conn, col, rid, value)?;
                }
                n += 1;
            }
            Ok(n)
        })
    }

    /// Delete rows by rid; relation links cascade automatically (FKs).
    /// Returns the number deleted.
    pub fn delete_rows(&self, table_id: &str, rids: &[String]) -> Result<usize> {
        if rids.is_empty() {
            return Ok(0);
        }
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let qtab = quote_ident(&table.sql_name);
            let mut deleted = 0;
            for chunk in rids.chunks(IN_CHUNK) {
                let sql = format!(
                    r#"DELETE FROM {qtab} WHERE "_rid" IN ({})"#,
                    in_placeholders(chunk.len())
                );
                deleted += conn
                    .execute(
                        &sql,
                        rusqlite::params_from_iter(chunk.iter().map(|s| s.as_str())),
                    )
                    .map_err(map_sqlite_err)?;
            }
            Ok(deleted)
        })
    }

    /// Internal: load column metadata for a single column (used by M3 shell).
    pub fn get_column(&self, table_id: &str, col_id: &str) -> Result<ColumnMeta> {
        self.with_conn(|conn| load_column(conn, table_id, col_id))
    }
}
