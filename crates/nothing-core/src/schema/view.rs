//! View operations on [`Workspace`].
//!
//! Grid views are pure metadata: filters/sorts plus their own `view_column`
//! nodes (width/order/hidden). SQL views are stored statements validated at
//! write time (铁律 4) and executed only on a `query_only` connection — there
//! is no physical `CREATE VIEW` object any more, so metadata is the single
//! source of truth.

use rusqlite::{Connection, OptionalExtension};

use super::ident::{new_id, now_iso, validate_user_name};
use super::table::map_sqlite_err;
use super::{
    load_table, load_view, load_view_columns, next_position, normalize_color, raw_from_row,
    view_column_from_raw, view_from_raw, FilterNode, GridConfig, NewView, RawMeta, ViewColumnMeta,
    ViewColumnPatch, ViewData, ViewKind, ViewMeta, ViewPatch,
};
use crate::db::Workspace;
use crate::error::{AppError, Result};

/// Validate a user-written SQL view statement (铁律 4):
/// single statement, SELECT/WITH only, syntax- and schema-checked via
/// prepare + EXPLAIN under `query_only` so nothing can execute even by
/// accident.
pub(crate) fn validate_sql_statement(conn: &Connection, sql: &str) -> Result<String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("SQL 语句不能为空".into()));
    }
    if trimmed.len() > 100_000 {
        return Err(AppError::InvalidInput("SQL 语句过长".into()));
    }
    let statement = trimmed.trim_end_matches(';').trim();
    if statement.contains(';') {
        return Err(AppError::InvalidInput("SQL 视图只允许单条语句".into()));
    }
    let lower = statement.to_ascii_lowercase();
    let starts_ok = lower.starts_with("select") || lower.starts_with("with");
    // Reject a leading comment used to smuggle another statement in.
    let stripped = lower.trim_start_matches(|c: char| c.is_whitespace());
    let starts_ok = starts_ok && !stripped.starts_with("/*") && !stripped.starts_with("--");
    if !starts_ok {
        return Err(AppError::InvalidInput(
            "SQL 视图只支持 SELECT / WITH 查询".into(),
        ));
    }

    // Validate under query_only so nothing can execute even by accident.
    // The previous value is restored: on the dedicated read connection
    // query_only must stay ON permanently.
    let prev_query_only: i64 = conn
        .pragma_query_value(None, "query_only", |r| r.get(0))
        .unwrap_or(0);
    conn.pragma_update(None, "query_only", "ON")?;
    let check = (|| -> Result<()> {
        // prepare validates syntax + referenced objects without executing.
        drop(
            conn.prepare(statement)
                .map_err(|e| AppError::InvalidInput(format!("SQL 无法编译: {e}")))?,
        );
        drop(
            conn.prepare(&format!("EXPLAIN {statement}"))
                .map_err(|e| AppError::InvalidInput(format!("SQL 无法编译: {e}")))?,
        );
        Ok(())
    })();
    conn.pragma_update(
        None,
        "query_only",
        if prev_query_only != 0 { "ON" } else { "OFF" },
    )?;
    check?;
    Ok(statement.to_string())
}

/// Validate that every column id referenced by a grid config exists in the
/// view's table.
fn validate_grid_config(conn: &Connection, table_id: &str, cfg: &GridConfig) -> Result<()> {
    let mut ids: Vec<&str> = Vec::new();
    ids.extend(cfg.sorts.iter().map(|s| s.column_id.as_str()));
    collect_filter_columns(cfg.filters.as_ref(), &mut ids);
    for id in ids {
        let found: bool = conn
            .query_row(
                r#"SELECT 1 FROM "_meta"
                   WHERE "parent_id" = ?1 AND "kind" = 'column' AND "id" = ?2"#,
                rusqlite::params![table_id, id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !found {
            return Err(AppError::NotFound(format!("视图引用的列 {id}")));
        }
    }
    Ok(())
}

fn collect_filter_columns<'a>(node: Option<&'a FilterNode>, out: &mut Vec<&'a str>) {
    match node {
        None => {}
        Some(FilterNode::Rule(r)) => out.push(r.column_id.as_str()),
        Some(FilterNode::Group { children, .. }) => {
            for child in children {
                collect_filter_columns(Some(child), out);
            }
        }
    }
}

fn load_view_column(conn: &Connection, view_id: &str, column_id: &str) -> Result<ViewColumnMeta> {
    let raw: RawMeta = conn
        .query_row(
            &format!(
                r#"SELECT {} FROM "_meta"
                   WHERE "kind" = 'view_column' AND "parent_id" = ?1 AND "ref_id" = ?2"#,
                super::META_COLS
            ),
            rusqlite::params![view_id, column_id],
            raw_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("视图列 {column_id}")))?;
    Ok(view_column_from_raw(raw)?)
}

/// Move one view column to `target` and renumber the layout densely.
fn reorder_view_columns(
    conn: &Connection,
    view_id: &str,
    column_id: &str,
    target: i64,
) -> Result<()> {
    let cols = load_view_columns(conn, view_id)?;
    let mut ids: Vec<(String, String)> = cols.into_iter().map(|c| (c.id, c.column_id)).collect();
    let idx = ids
        .iter()
        .position(|(_, cid)| cid == column_id)
        .ok_or_else(|| AppError::NotFound(format!("视图列 {column_id}")))?;
    let moved = ids.remove(idx);
    let target = target.clamp(0, ids.len() as i64) as usize;
    ids.insert(target, moved);
    for (i, (id, _)) in ids.iter().enumerate() {
        conn.execute(
            r#"UPDATE "_meta" SET "position" = ?1 WHERE "id" = ?2 AND "kind" = 'view_column'"#,
            rusqlite::params![i as i64, id],
        )?;
    }
    Ok(())
}

/// Materialize `view_column` nodes for every current table column.
fn materialize_view_columns(conn: &Connection, view_id: &str, table_id: &str) -> Result<()> {
    for col in super::load_columns(conn, table_id)? {
        let id = new_id();
        super::insert_view_column(conn, view_id, &id, &col.id, col.position, col.width, false)?;
    }
    Ok(())
}

impl Workspace {
    /// Create a view. Grid views require a `table_id`; SQL views are
    /// workspace-level (`table_id` must be `None`).
    pub fn create_view(&self, view: NewView) -> Result<ViewMeta> {
        let name = validate_user_name("视图名", &view.name)?;
        match (view.kind, &view.data) {
            (ViewKind::Grid, ViewData::Grid(_)) => {}
            (ViewKind::Sql, ViewData::Sql(_)) => {}
            _ => return Err(AppError::InvalidInput("视图类型与配置不匹配".into())),
        }
        if view.kind == ViewKind::Sql && view.table_id.is_some() {
            return Err(AppError::InvalidInput(
                "SQL 视图是工作区级的，不属于某张表".into(),
            ));
        }
        if view.kind == ViewKind::Grid && view.table_id.is_none() {
            return Err(AppError::InvalidInput("网格视图必须属于某张表".into()));
        }

        self.with_conn(|conn| {
            if let Some(table_id) = &view.table_id {
                load_table(conn, table_id)?;
            }
            // Name uniqueness within scope.
            let taken: bool = match &view.table_id {
                Some(tid) => conn
                    .query_row(
                        r#"SELECT 1 FROM "_meta"
                           WHERE "kind" = 'view' AND "parent_id" = ?1 AND "name" = ?2"#,
                        rusqlite::params![tid, name],
                        |_| Ok(true),
                    )
                    .optional()?
                    .unwrap_or(false),
                None => conn
                    .query_row(
                        r#"SELECT 1 FROM "_meta"
                           WHERE "kind" = 'view' AND "parent_id" IS NULL AND "name" = ?1"#,
                        [&name],
                        |_| Ok(true),
                    )
                    .optional()?
                    .unwrap_or(false),
            };
            if taken {
                return Err(AppError::AlreadyExists(format!("视图名 {name}")));
            }

            let id = new_id();
            let position = next_position(conn, view.table_id.as_deref(), "view")?;
            let meta = ViewMeta {
                id: id.clone(),
                table_id: view.table_id.clone(),
                name: name.clone(),
                kind: view.kind,
                icon: None,
                color: None,
                position,
                created_at: now_iso(),
                data: view.data.clone(),
                columns: Vec::new(),
            };

            let tx = conn.transaction()?;
            match &meta.data {
                ViewData::Grid(cfg) => {
                    let table_id = meta.table_id.as_deref().unwrap();
                    validate_grid_config(&tx, table_id, cfg)?;
                }
                ViewData::Sql(cfg) => {
                    validate_sql_statement(&tx, &cfg.statement)?;
                }
            }
            super::insert_view_node(&tx, &meta)?;
            if meta.kind == ViewKind::Grid {
                let table_id = meta.table_id.as_deref().unwrap();
                materialize_view_columns(&tx, &id, table_id)?;
            }
            tx.commit()?;
            load_view(conn, &id)
        })
    }

    /// List views. `Some(table_id)` → the table's grid views plus all
    /// workspace-level SQL views; `None` → every view.
    pub fn list_views(&self, table_id: Option<&str>) -> Result<Vec<ViewMeta>> {
        self.with_conn(|conn| {
            let sql = format!(
                r#"SELECT {} FROM "_meta"
                   WHERE "kind" = 'view'
                     AND (?1 IS NULL OR "parent_id" = ?1 OR "parent_id" IS NULL)
                   ORDER BY "position", "created_at""#,
                super::META_COLS
            );
            let mut stmt = conn.prepare(&sql)?;
            let raws = stmt
                .query_map(rusqlite::params![table_id], raw_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut out = Vec::with_capacity(raws.len());
            for raw in raws {
                let columns = load_view_columns(conn, &raw.id)?;
                out.push(view_from_raw(raw, columns)?);
            }
            Ok(out)
        })
    }

    pub fn get_view(&self, view_id: &str) -> Result<ViewMeta> {
        self.with_conn(|conn| load_view(conn, view_id))
    }

    /// Update a view's name / config / presentation / view-column layout.
    /// The kind is immutable — delete and recreate to switch between grid and
    /// SQL.
    pub fn update_view(&self, view_id: &str, patch: ViewPatch) -> Result<ViewMeta> {
        self.with_conn(|conn| {
            let old = load_view(conn, view_id)?;
            let name = match &patch.name {
                Some(n) => validate_user_name("视图名", n)?,
                None => old.name.clone(),
            };
            if name != old.name {
                let taken: bool = match &old.table_id {
                    Some(tid) => conn
                        .query_row(
                            r#"SELECT 1 FROM "_meta"
                               WHERE "kind" = 'view' AND "parent_id" = ?1
                                 AND "name" = ?2 AND "id" != ?3"#,
                            rusqlite::params![tid, name, view_id],
                            |_| Ok(true),
                        )
                        .optional()?
                        .unwrap_or(false),
                    None => conn
                        .query_row(
                            r#"SELECT 1 FROM "_meta"
                               WHERE "kind" = 'view' AND "parent_id" IS NULL
                                 AND "name" = ?1 AND "id" != ?2"#,
                            rusqlite::params![name, view_id],
                            |_| Ok(true),
                        )
                        .optional()?
                        .unwrap_or(false),
                };
                if taken {
                    return Err(AppError::AlreadyExists(format!("视图名 {name}")));
                }
            }
            let data = patch.data.clone().unwrap_or_else(|| old.data.clone());
            match (old.kind, &data) {
                (ViewKind::Grid, ViewData::Grid(_)) => {}
                (ViewKind::Sql, ViewData::Sql(_)) => {}
                _ => {
                    return Err(AppError::InvalidInput(
                        "视图类型与配置不匹配（类型不可变更）".into(),
                    ))
                }
            }

            let icon = match &patch.icon {
                Some(raw) => super::normalize_icon(Some(raw))?,
                None => old.icon.clone(),
            };
            let color = match &patch.color {
                Some(raw) => normalize_color(Some(raw))?,
                None => old.color,
            };
            let position = patch.position.unwrap_or(old.position);

            let tx = conn.transaction()?;
            let (filters, sorts, statement) = match &data {
                ViewData::Grid(cfg) => {
                    let table_id = old.table_id.as_deref().unwrap();
                    validate_grid_config(&tx, table_id, cfg)?;
                    (
                        cfg.filters
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?,
                        Some(serde_json::to_string(&cfg.sorts)?),
                        None,
                    )
                }
                ViewData::Sql(cfg) => {
                    let statement = validate_sql_statement(&tx, &cfg.statement)?;
                    (None, None, Some(statement))
                }
            };
            tx.execute(
                r#"UPDATE "_meta" SET
                     "name" = ?1, "icon" = ?2, "color" = ?3, "position" = ?4,
                     "filters" = ?5, "sorts" = ?6, "statement" = ?7,
                     "updated_at" = ?8
                   WHERE "id" = ?9 AND "kind" = 'view'"#,
                rusqlite::params![
                    name,
                    icon,
                    color.map(|c| c.as_str()),
                    position,
                    filters,
                    sorts,
                    statement,
                    now_iso(),
                    view_id
                ],
            )
            .map_err(map_sqlite_err)?;

            if let Some(cols) = &patch.columns {
                if old.kind != ViewKind::Grid {
                    return Err(AppError::InvalidInput("SQL 视图没有可调整的列布局".into()));
                }
                for c in cols {
                    let target = load_view_column(&tx, view_id, &c.column_id)?;
                    tx.execute(
                        r#"UPDATE "_meta" SET
                             "position" = ?1, "width" = ?2, "hidden" = ?3
                           WHERE "id" = ?4 AND "kind" = 'view_column'"#,
                        rusqlite::params![
                            c.position.unwrap_or(target.position),
                            c.width.unwrap_or(target.width),
                            c.hidden.unwrap_or(target.hidden) as i64,
                            target.id
                        ],
                    )?;
                }
            }
            tx.commit()?;
            load_view(conn, view_id)
        })
    }

    /// Update one view column (width / order / hidden) and return it.
    pub fn update_view_column(
        &self,
        view_id: &str,
        column_id: &str,
        patch: ViewColumnPatch,
    ) -> Result<ViewColumnMeta> {
        self.with_tx(|conn| {
            let view = load_view(conn, view_id)?;
            if view.kind != ViewKind::Grid {
                return Err(AppError::InvalidInput("只有网格视图有列布局".into()));
            }
            let target = load_view_column(conn, view_id, column_id)?;
            if let Some(pos) = patch.position {
                reorder_view_columns(conn, view_id, column_id, pos)?;
            }
            conn.execute(
                r#"UPDATE "_meta" SET "width" = ?1, "hidden" = ?2
                   WHERE "id" = ?3 AND "kind" = 'view_column'"#,
                rusqlite::params![
                    patch.width.unwrap_or(target.width),
                    patch.hidden.unwrap_or(target.hidden) as i64,
                    target.id
                ],
            )?;
            load_view_column(conn, view_id, column_id)
        })
    }

    /// Delete a view (its view-column nodes cascade).
    pub fn delete_view(&self, view_id: &str) -> Result<()> {
        self.with_tx(|conn| {
            load_view(conn, view_id)?;
            conn.execute(
                r#"DELETE FROM "_meta" WHERE "id" = ?1 AND "kind" = 'view'"#,
                [view_id],
            )?;
            Ok(())
        })
    }
}
