//! View operations on [`Workspace`].
//!
//! Grid views are pure metadata (filter tree + sorts + hidden columns; the
//! SQL compiler lives in the M2 query layer). SQL views are stored as real
//! `CREATE VIEW v_<id>` objects, validated at write time (铁律 4) and later
//! executed only on a `query_only` connection.

use rusqlite::{Connection, OptionalExtension};

use super::ident::{new_id, now_iso, validate_user_name, view_sql_name};
use super::table::map_sqlite_err;
use super::{
    load_table, load_view, view_from_row, FilterNode, GridConfig, NewView, ViewConfig, ViewKind,
    ViewMeta, ViewPatch,
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
    conn.pragma_update(None, "query_only", "OFF")?;
    check?;
    Ok(statement.to_string())
}

/// Validate that every column id referenced by a grid config exists in the
/// view's table.
fn validate_grid_config(conn: &Connection, table_id: &str, cfg: &GridConfig) -> Result<()> {
    let mut ids: Vec<&str> = Vec::new();
    ids.extend(cfg.sorts.iter().map(|s| s.column_id.as_str()));
    ids.extend(cfg.hidden_columns.iter().map(|s| s.as_str()));
    collect_filter_columns(cfg.filters.as_ref(), &mut ids);
    for id in ids {
        let found: bool = conn
            .query_row(
                r#"SELECT 1 FROM "_columns" WHERE "table_id" = ?1 AND "id" = ?2"#,
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

impl Workspace {
    /// Create a view. Grid views require a `table_id`; SQL views are
    /// workspace-level (`table_id` must be `None`).
    pub fn create_view(&self, view: NewView) -> Result<ViewMeta> {
        let name = validate_user_name("视图名", &view.name)?;
        match (view.kind, &view.config) {
            (ViewKind::Grid, ViewConfig::Grid(_)) => {}
            (ViewKind::Sql, ViewConfig::Sql(_)) => {}
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
                        r#"SELECT 1 FROM "_views" WHERE "table_id" = ?1 AND "name" = ?2"#,
                        rusqlite::params![tid, name],
                        |_| Ok(true),
                    )
                    .optional()?
                    .unwrap_or(false),
                None => conn
                    .query_row(
                        r#"SELECT 1 FROM "_views" WHERE "table_id" IS NULL AND "name" = ?1"#,
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
            let position: i64 = match &view.table_id {
                Some(tid) => conn.query_row(
                    r#"SELECT COALESCE(MAX("position"), -1) + 1 FROM "_views" WHERE "table_id" = ?1"#,
                    rusqlite::params![tid],
                    |r| r.get(0),
                )?,
                None => conn.query_row(
                    r#"SELECT COALESCE(MAX("position"), -1) + 1 FROM "_views" WHERE "table_id" IS NULL"#,
                    [],
                    |r| r.get(0),
                )?,
            };

            let meta = ViewMeta {
                id: id.clone(),
                table_id: view.table_id.clone(),
                name: name.clone(),
                kind: view.kind,
                config: view.config.clone(),
                position,
                created_at: now_iso(),
            };

            // Validation, physical CREATE VIEW and the metadata insert are
            // atomic (铁律 1).
            let tx = conn.transaction()?;
            match &meta.config {
                ViewConfig::Grid(cfg) => {
                    let table_id = meta.table_id.as_deref().unwrap();
                    validate_grid_config(&tx, table_id, cfg)?;
                }
                ViewConfig::Sql(cfg) => {
                    let statement = validate_sql_statement(&tx, &cfg.statement)?;
                    tx.execute_batch(&format!(
                        "CREATE VIEW {} AS {statement}",
                        super::ident::quote_ident(&view_sql_name(&id))
                    ))
                    .map_err(map_sqlite_err)?;
                }
            }
            insert_view_row(&tx, &meta)?;
            tx.commit()?;
            Ok(meta)
        })
    }

    /// List views. `Some(table_id)` → the table's grid views plus all
    /// workspace-level SQL views; `None` → every view.
    pub fn list_views(&self, table_id: Option<&str>) -> Result<Vec<ViewMeta>> {
        self.with_conn(|conn| {
            let sql = format!(
                r#"SELECT {} FROM "_views" WHERE (?1 IS NULL OR "table_id" = ?1 OR "table_id" IS NULL)
                   ORDER BY "position", "created_at""#,
                super::VIEW_COLS
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![table_id], view_from_row)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
    }

    pub fn get_view(&self, view_id: &str) -> Result<ViewMeta> {
        self.with_conn(|conn| load_view(conn, view_id))
    }

    /// Update a view's name / config / position. The kind is immutable —
    /// delete and recreate to switch between grid and SQL.
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
                            r#"SELECT 1 FROM "_views" WHERE "table_id" = ?1 AND "name" = ?2 AND "id" != ?3"#,
                            rusqlite::params![tid, name, view_id],
                            |_| Ok(true),
                        )
                        .optional()?
                        .unwrap_or(false),
                    None => conn
                        .query_row(
                            r#"SELECT 1 FROM "_views" WHERE "table_id" IS NULL AND "name" = ?1 AND "id" != ?2"#,
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
            let config = patch.config.clone().unwrap_or_else(|| old.config.clone());
            match (old.kind, &config) {
                (ViewKind::Grid, ViewConfig::Grid(_)) => {}
                (ViewKind::Sql, ViewConfig::Sql(_)) => {}
                _ => {
                    return Err(AppError::InvalidInput(
                        "视图类型与配置不匹配（类型不可变更）".into(),
                    ))
                }
            }

            let tx = conn.transaction()?;
            if let ViewConfig::Grid(cfg) = &config {
                let table_id = old.table_id.as_deref().unwrap();
                validate_grid_config(&tx, table_id, cfg)?;
            }
            if let ViewConfig::Sql(cfg) = &config {
                let statement = validate_sql_statement(&tx, &cfg.statement)?;
                // Recreate the physical view when the statement changed.
                let qv = super::ident::quote_ident(&view_sql_name(view_id));
                if old.config != config {
                    tx.execute_batch(&format!("DROP VIEW IF EXISTS {qv};"))?;
                    tx.execute_batch(&format!("CREATE VIEW {qv} AS {statement}"))
                        .map_err(map_sqlite_err)?;
                }
            }
            tx.execute(
                r#"UPDATE "_views" SET "name" = ?1, "config" = ?2 WHERE "id" = ?3"#,
                rusqlite::params![name, serde_json::to_string(&config)?, view_id],
            )
            .map_err(map_sqlite_err)?;
            if let Some(pos) = patch.position {
                tx.execute(
                    r#"UPDATE "_views" SET "position" = ?1 WHERE "id" = ?2"#,
                    rusqlite::params![pos, view_id],
                )?;
            }
            tx.commit()?;
            load_view(conn, view_id)
        })
    }

    /// Delete a view (drops the physical `v_<id>` view for SQL views).
    pub fn delete_view(&self, view_id: &str) -> Result<()> {
        self.with_tx(|conn| {
            let view = load_view(conn, view_id)?;
            if view.kind == ViewKind::Sql {
                conn.execute_batch(&format!(
                    "DROP VIEW IF EXISTS {}",
                    super::ident::quote_ident(&view_sql_name(view_id))
                ))?;
            }
            conn.execute(r#"DELETE FROM "_views" WHERE "id" = ?1"#, [view_id])?;
            Ok(())
        })
    }

    /// True physical name of a SQL view's backing `CREATE VIEW` object.
    pub fn sql_view_object_name(view_id: &str) -> String {
        view_sql_name(view_id)
    }
}

fn insert_view_row(conn: &Connection, v: &ViewMeta) -> Result<()> {
    conn.execute(
        r#"INSERT INTO "_views" ("id","table_id","name","kind","config","position","created_at")
           VALUES (?1,?2,?3,?4,?5,?6,?7)"#,
        rusqlite::params![
            v.id,
            v.table_id,
            v.name,
            v.kind.as_str(),
            serde_json::to_string(&v.config)?,
            v.position,
            v.created_at,
        ],
    )
    .map_err(map_sqlite_err)?;
    Ok(())
}
