//! Row CRUD on [`Workspace`].
//!
//! Writes go through the single writer connection inside one transaction
//! (铁律 1/9). Cell values are validated against column metadata, then bound
//! as parameters; constraint violations surface as friendly [`AppError`]s via
//! [`map_sqlite_err`]. Relation cells write to the junction table (FKs
//! enforce target existence and cascade cleanup).

use std::collections::{HashMap, HashSet};

use rusqlite::{params_from_iter, Connection, OptionalExtension};

use super::{
    json_to_stored, stored_to_json, Cells, DeleteSnapshot, LinkSnapshot, Row, RowSnapshot,
};
use crate::db::Workspace;
use crate::error::{AppError, Result};
use crate::schema::ident::{junction_sql_name, new_id, now_iso, quote_ident};
use crate::schema::table::map_sqlite_err;
use crate::schema::{load_column, load_columns, load_table, ColumnMeta, ColumnType, TableMeta};

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
        if col.col_type() == crate::schema::ColumnType::Relation {
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
    let source_col_id = if let Some(origin) = col.origin_id() {
        origin
    } else {
        col.id.as_str()
    };
    let junction = quote_ident(&junction_sql_name(source_col_id));
    let fixed_side = if col.is_reverse() { "b" } else { "a" };

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
        let target_table_id = &col
            .relation()
            .ok_or_else(|| AppError::Internal("关联列缺少关联数据".into()))?
            .target_table_id;
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
                cols_sql.push(quote_ident(col.sql_name().unwrap_or_default()));
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
                sets.push(format!(
                    "{} = ?",
                    quote_ident(col.sql_name().unwrap_or_default())
                ));
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
        if col.is_reverse() || col.col_type() == crate::schema::ColumnType::Formula {
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
        Ok(self.delete_rows_snapshot(table_id, rids)?.rows.len())
    }

    /// Delete rows while capturing everything needed to undo the operation:
    /// the physical cells of each row plus **every** junction edge that touches
    /// them (outbound links and inbound links from other tables).
    ///
    /// Snapshot and DELETE run in the same transaction, so no concurrent change
    /// can slip between them (铁律 1/9).
    pub fn delete_rows_snapshot(&self, table_id: &str, rids: &[String]) -> Result<DeleteSnapshot> {
        if rids.is_empty() {
            return Ok(DeleteSnapshot {
                table_id: table_id.to_string(),
                rows: Vec::new(),
                links: Vec::new(),
            });
        }
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let cols = load_columns(conn, table_id)?;
            let qtab = quote_ident(&table.sql_name);
            // Formula columns are generated and reverse relations live in the
            // junction table: neither belongs in the physical snapshot.
            let restorable: Vec<&ColumnMeta> = cols
                .iter()
                .filter(|c| c.is_physical() && c.col_type() != ColumnType::Formula)
                .collect();

            // ---- physical rows -------------------------------------------
            let mut rows = Vec::new();
            let mut select = vec![
                quote_ident("_rid"),
                quote_ident("_created"),
                quote_ident("_updated"),
            ];
            select.extend(
                restorable
                    .iter()
                    .map(|c| quote_ident(c.sql_name().unwrap_or_default())),
            );
            for chunk in rids.chunks(IN_CHUNK) {
                let sql = format!(
                    "SELECT {} FROM {qtab} WHERE {} IN ({})",
                    select.join(", "),
                    quote_ident("_rid"),
                    in_placeholders(chunk.len())
                );
                let mut stmt = conn.prepare(&sql)?;
                let snapshots = stmt
                    .query_map(params_from_iter(chunk.iter().map(|s| s.as_str())), |r| {
                        let mut cells = Cells::new();
                        for (i, col) in restorable.iter().enumerate() {
                            let value = r.get_ref(3 + i)?;
                            let json = stored_to_json(col, value).map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    3 + i,
                                    rusqlite::types::Type::Null,
                                    Box::new(e),
                                )
                            })?;
                            cells.insert(col.id.clone(), json);
                        }
                        Ok(RowSnapshot {
                            rid: r.get(0)?,
                            created: r.get(1)?,
                            updated: r.get(2)?,
                            cells,
                        })
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                rows.extend(snapshots);
            }
            rows.sort_by(|a, b| a.rid.cmp(&b.rid));

            // ---- junction edges touching the deleted rows -----------------
            // A relation column is relevant when it belongs to this table
            // (outbound) or targets this table (inbound). Reverse columns share
            // the source column's junction, so resolve `origin_id` first.
            let mut source_columns: Vec<String> = Vec::new();
            {
                let mut stmt = conn.prepare(
                    r#"SELECT "id", "origin_id" FROM "_meta"
                       WHERE "kind" = 'column' AND "col_type" = 'relation'
                         AND ("parent_id" = ?1 OR "target_table_id" = ?1)"#,
                )?;
                let mut seen = HashSet::new();
                let mut meta_rows = stmt.query_map([table_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })?;
                while let Some((id, origin)) = meta_rows.next().transpose()? {
                    let source = origin.unwrap_or(id);
                    if seen.insert(source.clone()) {
                        source_columns.push(source);
                    }
                }
            }

            let mut links: Vec<LinkSnapshot> = Vec::new();
            let mut seen_links: HashSet<(String, String, String)> = HashSet::new();
            for source in &source_columns {
                let junction = quote_ident(&junction_sql_name(source));
                for chunk in rids.chunks(IN_CHUNK) {
                    let placeholders = in_placeholders(chunk.len());
                    let sql = format!(
                        r#"SELECT "a", "b", "ord" FROM {junction}
                           WHERE "a" IN ({placeholders}) OR "b" IN ({placeholders})"#
                    );
                    let mut params: Vec<&str> = chunk.iter().map(String::as_str).collect();
                    params.extend(chunk.iter().map(String::as_str));
                    let mut stmt = conn.prepare(&sql)?;
                    let edges = stmt
                        .query_map(params_from_iter(params), |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, i64>(2)?,
                            ))
                        })?
                        .collect::<std::result::Result<Vec<_>, _>>()?;
                    for (a, b, ord) in edges {
                        if seen_links.insert((source.clone(), a.clone(), b.clone())) {
                            links.push(LinkSnapshot {
                                column_id: source.clone(),
                                a,
                                b,
                                ord,
                            });
                        }
                    }
                }
            }

            // ---- delete ---------------------------------------------------
            for chunk in rids.chunks(IN_CHUNK) {
                let sql = format!(
                    r#"DELETE FROM {qtab} WHERE "_rid" IN ({})"#,
                    in_placeholders(chunk.len())
                );
                conn.execute(&sql, params_from_iter(chunk.iter().map(|s| s.as_str())))
                    .map_err(map_sqlite_err)?;
            }

            Ok(DeleteSnapshot {
                table_id: table_id.to_string(),
                rows,
                links,
            })
        })
    }

    /// Restore a [`DeleteSnapshot`] exactly: same `_rid`/timestamps, same
    /// physical values, and every junction edge (inbound links included).
    ///
    /// All rows and links are written in one transaction. Formula columns are
    /// recomputed by SQLite; relation cells are restored from the link list.
    pub fn restore_rows(&self, snapshot: &DeleteSnapshot) -> Result<usize> {
        self.with_tx(|conn| {
            let table = load_table(conn, &snapshot.table_id)?;
            let cols = load_columns(conn, &snapshot.table_id)?;
            let by_id: HashMap<&str, &ColumnMeta> =
                cols.iter().map(|c| (c.id.as_str(), c)).collect();
            let qtab = quote_ident(&table.sql_name);

            for row in &snapshot.rows {
                let mut insert_cols = vec![
                    quote_ident("_rid"),
                    quote_ident("_created"),
                    quote_ident("_updated"),
                ];
                let mut values = vec![
                    rusqlite::types::Value::Text(row.rid.clone()),
                    rusqlite::types::Value::Text(row.created.clone()),
                    rusqlite::types::Value::Text(row.updated.clone()),
                ];
                let mut cell_ids: Vec<&String> = row.cells.keys().collect();
                cell_ids.sort();
                for id in cell_ids {
                    let Some(col) = by_id.get(id.as_str()) else {
                        continue;
                    };
                    if !col.is_physical() || col.col_type() == ColumnType::Formula {
                        continue;
                    }
                    if let Some(value) = json_to_stored(col, &row.cells[id])? {
                        insert_cols.push(quote_ident(col.sql_name().unwrap_or_default()));
                        values.push(value);
                    }
                }
                let sql = format!(
                    "INSERT INTO {qtab} ({}) VALUES ({})",
                    insert_cols.join(", "),
                    in_placeholders(values.len())
                );
                conn.execute(&sql, params_from_iter(values))
                    .map_err(map_sqlite_err)?;
            }

            // Links may belong to another table's relation column (inbound
            // edges); the junction name is derived from the source column id.
            for link in &snapshot.links {
                let junction = quote_ident(&junction_sql_name(&link.column_id));
                conn.execute(
                    &format!(r#"INSERT INTO {junction} ("a", "b", "ord") VALUES (?1, ?2, ?3)"#),
                    rusqlite::params![link.a, link.b, link.ord],
                )
                .map_err(map_sqlite_err)?;
            }

            Ok(snapshot.rows.len())
        })
    }

    /// Load column metadata for a single column.
    pub fn get_column(&self, table_id: &str, col_id: &str) -> Result<ColumnMeta> {
        self.with_conn(|conn| load_column(conn, table_id, col_id))
    }
}
