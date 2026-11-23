//! Read path: grid view execution, SQL view / ad-hoc query execution on the
//! read-only connection, FTS search, and batched relation-title resolution.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::compiler::{compile, like_escape};
use super::rows::{in_placeholders, IN_CHUNK};
use super::{
    clamp_pagination, stored_to_json, valueref_to_json, Row, RowPage, SqlColumn, SqlResult,
};
use crate::db::Workspace;
use crate::error::{AppError, Result};
use crate::schema::fts::fts_table_name;
use crate::schema::ident::{junction_sql_name, quote_ident};
use crate::schema::view::validate_sql_statement;
use crate::schema::{
    load_columns, load_table, load_view, ColumnMeta, ColumnType, GridConfig, TableMeta,
    ViewColumnMeta, ViewData,
};

/// Outcome of [`Workspace::run_view`]: grid views yield rows, SQL views yield
/// a raw columnar result.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewResult {
    Grid(RowPage),
    Sql(SqlResult),
}

/// Base columns in definition order (default layout for a raw table/search).
fn sorted_columns(cols: &[ColumnMeta]) -> Vec<ColumnMeta> {
    let mut out = cols.to_vec();
    out.sort_by_key(|c| c.position);
    out
}

/// Apply a view's own column nodes: order, visibility and per-view width.
/// Columns missing from a layout are appended defensively (materialization
/// normally keeps every view complete).
fn view_columns(
    cols: &[ColumnMeta],
    layout: &[ViewColumnMeta],
    apply_hidden: bool,
) -> Vec<ColumnMeta> {
    let by_id: HashMap<&str, &ColumnMeta> = cols.iter().map(|c| (c.id.as_str(), c)).collect();
    let layout_ids: HashSet<&str> = layout.iter().map(|v| v.column_id.as_str()).collect();
    let mut ordered: Vec<&ViewColumnMeta> = layout
        .iter()
        .filter(|v| !apply_hidden || !v.hidden)
        .collect();
    ordered.sort_by_key(|v| v.position);

    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(ordered.len());
    for vc in ordered {
        if !seen.insert(vc.column_id.as_str()) {
            continue;
        }
        if let Some(base) = by_id.get(vc.column_id.as_str()) {
            let mut c = (*base).clone();
            c.width = vc.width;
            out.push(c);
        }
    }
    for c in cols {
        if !layout_ids.contains(c.id.as_str()) {
            out.push(c.clone());
        }
    }
    out
}

/// Run one paged SELECT against a user table and decode typed cells.
#[allow(clippy::too_many_arguments)]
fn fetch_page(
    conn: &Connection,
    table: &TableMeta,
    cols: &[ColumnMeta],
    where_sql: &str,
    where_params: &[Value],
    order_sql: &str,
    limit: i64,
    offset: i64,
) -> Result<(Vec<Row>, i64)> {
    let qtab = quote_ident(&table.sql_name);
    let physical: Vec<&ColumnMeta> = cols.iter().filter(|c| c.is_physical()).collect();

    let total: i64 = conn.query_row(
        &format!("SELECT count(*) FROM {qtab} WHERE {where_sql}"),
        rusqlite::params_from_iter(where_params.iter()),
        |r| r.get(0),
    )?;

    let mut select_cols = vec![
        quote_ident("_rid"),
        quote_ident("_created"),
        quote_ident("_updated"),
    ];
    select_cols.extend(
        physical
            .iter()
            .map(|c| quote_ident(c.sql_name().unwrap_or_default())),
    );
    let sql = format!(
        "SELECT {} FROM {qtab} WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?",
        select_cols.join(", ")
    );
    let mut params: Vec<Value> = where_params.to_vec();
    params.push(Value::Integer(limit));
    params.push(Value::Integer(offset));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let mut row = Row {
                rid: r.get(0)?,
                created: r.get(1)?,
                updated: r.get(2)?,
                cells: Default::default(),
            };
            for (i, col) in physical.iter().enumerate() {
                let v = r.get_ref(3 + i)?;
                let json = stored_to_json(col, v).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3 + i,
                        rusqlite::types::Type::Null,
                        Box::new(e),
                    )
                })?;
                row.cells.insert(col.id.clone(), json);
            }
            Ok(row)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok((rows, total))
}

/// Fill relation/reverse cells for a page of rows with **one query per
/// relation column** (chunked), and collect the referenced rids per target
/// table so titles can be batch-resolved (防 N+1).
fn attach_relations(
    conn: &Connection,
    cols: &[ColumnMeta],
    rows: &mut [Row],
) -> Result<HashMap<String, HashSet<String>>> {
    let mut title_requests: HashMap<String, HashSet<String>> = HashMap::new();
    if rows.is_empty() {
        return Ok(title_requests);
    }
    for col in cols.iter().filter(|c| c.col_type() == ColumnType::Relation) {
        let source_col_id = match col.origin_id() {
            Some(src) => src.to_string(),
            None => col.id.clone(),
        };
        let junction = quote_ident(&junction_sql_name(&source_col_id));
        let (fixed_side, other_side) = if col.is_reverse() {
            ("b", "a")
        } else {
            ("a", "b")
        };
        let target_table_id = col
            .relation()
            .ok_or_else(|| AppError::Internal("关联列缺少关联数据".into()))?
            .target_table_id
            .clone();

        let page_rids: Vec<&str> = rows.iter().map(|r| r.rid.as_str()).collect();
        let mut links: HashMap<String, Vec<String>> = HashMap::new();
        for chunk in page_rids.chunks(IN_CHUNK) {
            let sql = format!(
                r#"SELECT "{fixed_side}", "{other_side}" FROM {junction}
                   WHERE "{fixed_side}" IN ({}) ORDER BY "ord", rowid"#,
                in_placeholders(chunk.len())
            );
            let mut stmt = conn.prepare(&sql)?;
            let pairs = stmt
                .query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (fixed, other) in pairs {
                links.entry(fixed).or_default().push(other);
            }
        }
        for row in rows.iter_mut() {
            let others = links.remove(&row.rid).unwrap_or_default();
            for o in &others {
                title_requests
                    .entry(target_table_id.clone())
                    .or_default()
                    .insert(o.clone());
            }
            row.cells.insert(col.id.clone(), serde_json::json!(others));
        }
    }
    Ok(title_requests)
}

/// Batch-resolve display titles: one query per referenced table.
fn resolve_titles(
    conn: &Connection,
    requests: HashMap<String, HashSet<String>>,
) -> Result<HashMap<String, String>> {
    let mut titles = HashMap::new();
    for (table_id, rids) in requests {
        let table = load_table(conn, &table_id)?;
        let Some(title_col_id) = &table.title_col_id else {
            continue;
        };
        let Some(title_col) = load_columns(conn, &table_id)?
            .into_iter()
            .find(|c| &c.id == title_col_id)
        else {
            continue;
        };
        let Some(title_sql) = title_col.sql_name() else {
            continue;
        };
        let qtab = quote_ident(&table.sql_name);
        let qtitle = quote_ident(title_sql);
        for chunk in rids
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .chunks(IN_CHUNK)
        {
            let sql = format!(
                r#"SELECT "_rid", {qtitle} FROM {qtab} WHERE "_rid" IN ({})"#,
                in_placeholders(chunk.len())
            );
            let mut stmt = conn.prepare(&sql)?;
            let pairs = stmt
                .query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (rid, title) in pairs {
                if let Some(t) = title {
                    titles.insert(rid, t);
                }
            }
        }
    }
    Ok(titles)
}

/// Execute an already-built SELECT and decode a raw columnar result.
fn execute_sql(conn: &Connection, sql: &str, params: &[Value]) -> Result<SqlResult> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| AppError::InvalidInput(format!("SQL 无法编译: {e}")))?;
    let columns: Vec<SqlColumn> = stmt
        .columns()
        .iter()
        .map(|c| SqlColumn {
            name: c.name().to_string(),
            decl_type: c.decl_type().map(String::from),
        })
        .collect();
    let n = columns.len();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), move |r| {
            let mut row = Vec::with_capacity(n);
            for i in 0..n {
                row.push(valueref_to_json(r.get_ref(i)?));
            }
            Ok(row)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(SqlResult { columns, rows })
}

impl Workspace {
    /// Load one row by rid, including relation cells.
    pub fn get_row(&self, table_id: &str, rid: &str) -> Result<Row> {
        self.with_read(|conn| {
            let table = load_table(conn, table_id)?;
            let cols = load_columns(conn, table_id)?;
            let visible = sorted_columns(&cols);
            let (mut rows, _) = fetch_page(
                conn,
                &table,
                &visible,
                &format!("{} = ?", quote_ident("_rid")),
                &[Value::Text(rid.into())],
                &format!("ORDER BY {}", quote_ident("_rid")),
                1,
                0,
            )?;
            let mut row = rows
                .pop()
                .ok_or_else(|| AppError::NotFound(format!("行 {rid}")))?;
            attach_relations(conn, &visible, std::slice::from_mut(&mut row))?;
            Ok(row)
        })
    }

    /// Page through a table with no view config (default `_rid` order).
    pub fn list_rows(
        &self,
        table_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<RowPage> {
        let (limit, offset) = clamp_pagination(limit, offset);
        self.with_read(|conn| {
            let table = load_table(conn, table_id)?;
            let cols = load_columns(conn, table_id)?;
            let visible = sorted_columns(&cols);
            self.page_rows(
                conn,
                &table,
                &cols,
                &visible,
                &GridConfig::default(),
                limit,
                offset,
            )
        })
    }

    /// Execute a view: grid views compile to parameterized SQL; SQL views run
    /// their stored statement on the read-only connection.
    pub fn run_view(
        &self,
        view_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<ViewResult> {
        let (limit, offset) = clamp_pagination(limit, offset);
        self.with_read(|conn| {
            let view = load_view(conn, view_id)?;
            match &view.data {
                ViewData::Grid(cfg) => {
                    let table_id = view
                        .table_id
                        .as_deref()
                        .ok_or_else(|| AppError::Internal("网格视图缺少 table_id".into()))?;
                    let table = load_table(conn, table_id)?;
                    let cols = load_columns(conn, table_id)?;
                    let visible = view_columns(&cols, &view.columns, true);
                    let page = self.page_rows(conn, &table, &cols, &visible, cfg, limit, offset)?;
                    Ok(ViewResult::Grid(page))
                }
                ViewData::Sql(cfg) => {
                    let result = self.exec_sql_view(conn, &cfg.statement, limit, offset)?;
                    Ok(ViewResult::Sql(result))
                }
            }
        })
    }

    /// Execute a stored SQL view read-only.
    pub fn run_sql_view(
        &self,
        view_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<SqlResult> {
        let (limit, offset) = clamp_pagination(limit, offset);
        self.with_read(|conn| {
            let view = load_view(conn, view_id)?;
            let ViewData::Sql(cfg) = &view.data else {
                return Err(AppError::InvalidInput("不是 SQL 视图".into()));
            };
            self.exec_sql_view(conn, &cfg.statement, limit, offset)
        })
    }

    /// Validate and run an ad-hoc SELECT/WITH statement read-only.
    pub fn run_sql(&self, sql: &str, limit: Option<i64>, offset: Option<i64>) -> Result<SqlResult> {
        let (limit, offset) = clamp_pagination(limit, offset);
        self.with_read(|conn| {
            let statement = validate_sql_statement(conn, sql)?;
            let wrapped = format!("SELECT * FROM ({statement}) LIMIT ? OFFSET ?",);
            execute_sql(
                conn,
                &wrapped,
                &[Value::Integer(limit), Value::Integer(offset)],
            )
        })
    }

    /// Full-text search over a table's searchable columns.
    ///
    /// Queries of ≥3 characters use the FTS5 trigram index; shorter queries
    /// (and tables without an FTS index) fall back to escaped LIKE.
    pub fn search(
        &self,
        table_id: &str,
        query: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<RowPage> {
        let (limit, offset) = clamp_pagination(limit, offset);
        let q = query.trim().to_string();
        if q.is_empty() {
            return Err(AppError::InvalidInput("搜索词不能为空".into()));
        }
        self.with_read(|conn| {
            let table = load_table(conn, table_id)?;
            let cols = load_columns(conn, table_id)?;
            let visible = sorted_columns(&cols);
            let fts = fts_table_name(&table.sql_name);
            let has_fts: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
                    [&fts],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);

            let (where_sql, where_params) = if has_fts && q.chars().count() >= 3 {
                let qfts = quote_ident(&fts);
                let phrase = Value::Text(format!("\"{}\"", q.replace('"', "\"\"")));
                (
                    format!("rowid IN (SELECT rowid FROM {qfts} WHERE {qfts} MATCH ?)"),
                    vec![phrase],
                )
            } else {
                let searchable: Vec<&ColumnMeta> = cols
                    .iter()
                    .filter(|c| c.is_physical() && c.col_type().is_searchable())
                    .collect();
                if searchable.is_empty() {
                    return Ok(RowPage {
                        columns: visible,
                        rows: Vec::new(),
                        total: 0,
                        titles: HashMap::new(),
                    });
                }
                let clauses: Vec<String> = searchable
                    .iter()
                    .map(|c| {
                        format!(
                            "{} LIKE ? ESCAPE '\\'",
                            quote_ident(c.sql_name().unwrap_or_default())
                        )
                    })
                    .collect();
                let pattern = Value::Text(format!("%{}%", like_escape(&q)));
                (
                    format!("({})", clauses.join(" OR ")),
                    vec![pattern; searchable.len()],
                )
            };

            let order_sql = format!("ORDER BY {}", quote_ident("_rid"));
            let (mut rows, total) = fetch_page(
                conn,
                &table,
                &visible,
                &where_sql,
                &where_params,
                &order_sql,
                limit,
                offset,
            )?;
            let requests = attach_relations(conn, &visible, &mut rows)?;
            let titles = resolve_titles(conn, requests)?;
            Ok(RowPage {
                columns: visible,
                rows,
                total,
                titles,
            })
        })
    }

    // -- internal ---------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn page_rows(
        &self,
        conn: &Connection,
        table: &TableMeta,
        all_cols: &[ColumnMeta],
        visible: &[ColumnMeta],
        cfg: &GridConfig,
        limit: i64,
        offset: i64,
    ) -> Result<RowPage> {
        let compiled = compile(table, all_cols, cfg)?;
        let (mut rows, total) = fetch_page(
            conn,
            table,
            visible,
            &compiled.where_sql,
            &compiled.where_params,
            &compiled.order_sql,
            limit,
            offset,
        )?;
        let requests = attach_relations(conn, visible, &mut rows)?;
        let titles = resolve_titles(conn, requests)?;
        Ok(RowPage {
            columns: visible.to_vec(),
            rows,
            total,
            titles,
        })
    }

    fn exec_sql_view(
        &self,
        conn: &Connection,
        statement: &str,
        limit: i64,
        offset: i64,
    ) -> Result<SqlResult> {
        let sql = format!("SELECT * FROM ({statement}) LIMIT ? OFFSET ?");
        execute_sql(conn, &sql, &[Value::Integer(limit), Value::Integer(offset)])
    }
}
