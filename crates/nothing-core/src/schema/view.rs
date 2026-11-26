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
    view_column_from_raw, view_from_raw, AggregateConfig, AggregateOp, ColumnMeta, ColumnType,
    FilterNode, GridConfig, NewView, RawMeta, ViewColumnMeta, ViewColumnPatch, ViewData, ViewKind,
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
    if let Some(aggregate) = &cfg.aggregate {
        validate_aggregate_config(conn, table_id, aggregate)?;
    }
    Ok(())
}

/// Whether a column's effective value can be a `GROUP BY` key in a summary
/// view. Relations and multi-selects are intentionally excluded: grouping them
/// would either join a junction table or split one row across several groups.
fn is_aggregate_groupable(col_type: ColumnType) -> bool {
    matches!(
        col_type,
        ColumnType::Text
            | ColumnType::Number
            | ColumnType::Select
            | ColumnType::Date
            | ColumnType::Checkbox
    )
}

fn metric_allowed(op: AggregateOp, col_type: ColumnType) -> bool {
    match op {
        AggregateOp::CountRows => true,
        AggregateOp::CountNonEmpty | AggregateOp::CountDistinct => is_aggregate_groupable(col_type),
        AggregateOp::Sum => {
            matches!(col_type, ColumnType::Number | ColumnType::Checkbox)
        }
        AggregateOp::Avg => col_type == ColumnType::Number,
        AggregateOp::Min | AggregateOp::Max => {
            matches!(col_type, ColumnType::Number | ColumnType::Date)
        }
    }
}

fn validate_aggregate_config(
    conn: &Connection,
    table_id: &str,
    cfg: &AggregateConfig,
) -> Result<()> {
    if cfg.metrics.is_empty() {
        return Err(AppError::InvalidInput("汇总视图至少需要一个指标".into()));
    }
    if cfg.metrics.len() > 8 {
        return Err(AppError::InvalidInput("汇总指标最多 8 个".into()));
    }
    if cfg.group_by.len() > 3 {
        return Err(AppError::InvalidInput("分组字段最多 3 个".into()));
    }

    let cols = super::load_columns(conn, table_id)?;
    let by_id: std::collections::HashMap<&str, &ColumnMeta> =
        cols.iter().map(|c| (c.id.as_str(), c)).collect();
    let column = |id: &str| {
        by_id
            .get(id)
            .copied()
            .ok_or_else(|| AppError::NotFound(format!("汇总视图引用的列 {id}")))
    };

    let mut seen_groups = std::collections::HashSet::new();
    for id in &cfg.group_by {
        if !seen_groups.insert(id.as_str()) {
            return Err(AppError::InvalidInput(format!("分组字段重复: {id}")));
        }
        let col = column(id)?;
        if !is_aggregate_groupable(col.effective_type()) {
            return Err(AppError::InvalidInput(format!(
                "列「{}」不能作为分组字段",
                col.name
            )));
        }
    }

    let mut seen_metrics = std::collections::HashSet::new();
    for metric in &cfg.metrics {
        let column_id = metric.column_id.as_deref().filter(|s| !s.is_empty());
        if metric.op == AggregateOp::CountRows {
            if column_id.is_some() {
                return Err(AppError::InvalidInput("「行数」指标不能指定列".into()));
            }
        } else {
            let id = column_id.ok_or_else(|| {
                AppError::InvalidInput(format!("指标「{}」必须选择一列", metric.op.as_str()))
            })?;
            let col = column(id)?;
            if !metric_allowed(metric.op, col.effective_type()) {
                return Err(AppError::InvalidInput(format!(
                    "列「{}」不支持「{}」汇总",
                    col.name,
                    metric.op.as_str()
                )));
            }
        }
        if !seen_metrics.insert((metric.op, column_id.map(str::to_string))) {
            return Err(AppError::InvalidInput("汇总指标重复".into()));
        }
    }

    if let Some(sort) = &cfg.sort {
        if let Some(index) = sort.metric {
            if index >= cfg.metrics.len() {
                return Err(AppError::InvalidInput("汇总排序引用了不存在的指标".into()));
            }
        }
    }
    Ok(())
}

/// Refuse a column type change that would make an existing summary view
/// invalid. Deleting a column is handled by [`prune_aggregate_column`] instead:
/// a summary can lose a metric without losing the view itself.
pub(crate) fn ensure_aggregate_column_compatible(
    conn: &Connection,
    table_id: &str,
    column_id: &str,
    new_type: ColumnType,
) -> Result<()> {
    let mut stmt = conn.prepare(
        r#"SELECT "name", "aggregate" FROM "_meta"
           WHERE "kind" = 'view' AND "parent_id" = ?1 AND "aggregate" IS NOT NULL"#,
    )?;
    let rows = stmt.query_map([table_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut invalid = Vec::new();
    for row in rows {
        let (name, raw) = row?;
        let Ok(cfg) = serde_json::from_str::<AggregateConfig>(&raw) else {
            continue;
        };
        if cfg.group_by.iter().any(|id| id == column_id) && !is_aggregate_groupable(new_type) {
            invalid.push(name);
            continue;
        }
        let bad_metric = cfg
            .metrics
            .iter()
            .any(|m| m.column_id.as_deref() == Some(column_id) && !metric_allowed(m.op, new_type));
        if bad_metric {
            invalid.push(name);
        }
    }
    if invalid.is_empty() {
        Ok(())
    } else {
        Err(AppError::Rejected(format!(
            "以下汇总视图依赖该列：{}；请先调整这些视图再修改列类型",
            invalid.join("、")
        )))
    }
}

/// Remove a deleted column from every summary view of the table. The view is
/// kept usable: if the column was its only metric, a row-count metric remains.
pub(crate) fn prune_aggregate_column(
    conn: &Connection,
    table_id: &str,
    column_id: &str,
) -> Result<()> {
    let mut stmt = conn.prepare(
        r#"SELECT "id", "aggregate" FROM "_meta"
           WHERE "kind" = 'view' AND "parent_id" = ?1 AND "aggregate" IS NOT NULL"#,
    )?;
    let raws = stmt
        .query_map([table_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    for (view_id, raw) in raws {
        let Ok(mut cfg) = serde_json::from_str::<AggregateConfig>(&raw) else {
            continue;
        };
        let mut changed = false;

        let before = cfg.group_by.len();
        cfg.group_by.retain(|id| id != column_id);
        changed |= cfg.group_by.len() != before;

        let old_metrics = std::mem::take(&mut cfg.metrics);
        let mut removed_indexes = Vec::new();
        for (i, metric) in old_metrics.iter().enumerate() {
            if metric.column_id.as_deref() == Some(column_id) {
                removed_indexes.push(i);
            } else {
                cfg.metrics.push(metric.clone());
            }
        }
        changed |= !removed_indexes.is_empty();
        if cfg.metrics.is_empty() {
            cfg.metrics.push(super::AggregateMetric {
                op: super::AggregateOp::CountRows,
                column_id: None,
            });
            changed = true;
        }
        if let Some((index, desc)) = cfg
            .sort
            .as_ref()
            .and_then(|s| s.metric.map(|i| (i, s.desc)))
        {
            if removed_indexes.contains(&index) {
                cfg.sort = None;
                changed = true;
            } else {
                let shift = removed_indexes.iter().filter(|&&i| i < index).count();
                if shift > 0 {
                    cfg.sort = Some(super::AggregateSort {
                        metric: Some(index - shift),
                        desc,
                    });
                    changed = true;
                }
            }
        }
        if changed {
            conn.execute(
                r#"UPDATE "_meta" SET "aggregate" = ?1, "updated_at" = ?2
                   WHERE "id" = ?3 AND "kind" = 'view'"#,
                rusqlite::params![
                    serde_json::to_string(&cfg)?,
                    super::ident::now_iso(),
                    view_id
                ],
            )?;
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

/// Move a view to `target` within its own scope (a table's grid views, or the
/// workspace-level SQL views) and renumber that scope densely.
fn reorder_views(
    conn: &Connection,
    view_id: &str,
    parent_id: Option<&str>,
    target: i64,
) -> Result<()> {
    let mut ids: Vec<String> = match parent_id {
        Some(p) => conn
            .prepare(
                r#"SELECT "id" FROM "_meta"
                   WHERE "kind" = 'view' AND "parent_id" = ?1
                   ORDER BY "position", "created_at", "id""#,
            )?
            .query_map([p], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?,
        None => conn
            .prepare(
                r#"SELECT "id" FROM "_meta"
                   WHERE "kind" = 'view' AND "parent_id" IS NULL
                   ORDER BY "position", "created_at", "id""#,
            )?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?,
    };
    let idx = ids
        .iter()
        .position(|id| id == view_id)
        .ok_or_else(|| AppError::NotFound(format!("视图 {view_id}")))?;
    let moved = ids.remove(idx);
    let target = target.clamp(0, ids.len() as i64) as usize;
    ids.insert(target, moved);
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            r#"UPDATE "_meta" SET "position" = ?1 WHERE "id" = ?2 AND "kind" = 'view'"#,
            rusqlite::params![i as i64, id],
        )?;
    }
    Ok(())
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
        super::insert_view_column(
            conn,
            view_id,
            &id,
            &col.id,
            col.position,
            col.width,
            false,
            false,
        )?;
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
            let tx = conn.transaction()?;
            let (filters, sorts, statement, aggregate) = match &data {
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
                        cfg.aggregate
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?,
                    )
                }
                ViewData::Sql(cfg) => {
                    let statement = validate_sql_statement(&tx, &cfg.statement)?;
                    (None, None, Some(statement), None)
                }
            };
            tx.execute(
                r#"UPDATE "_meta" SET
                     "name" = ?1, "icon" = ?2, "color" = ?3,
                     "filters" = ?4, "sorts" = ?5, "statement" = ?6,
                     "aggregate" = ?7, "updated_at" = ?8
                   WHERE "id" = ?9 AND "kind" = 'view'"#,
                rusqlite::params![
                    name,
                    icon,
                    color.as_ref().map(|c| c.as_str()),
                    filters,
                    sorts,
                    statement,
                    aggregate,
                    now_iso(),
                    view_id
                ],
            )
            .map_err(map_sqlite_err)?;

            if let Some(target) = patch.position {
                reorder_views(&tx, view_id, old.table_id.as_deref(), target)?;
            }

            if let Some(cols) = &patch.columns {
                if old.kind != ViewKind::Grid {
                    return Err(AppError::InvalidInput("SQL 视图没有可调整的列布局".into()));
                }
                for c in cols {
                    let target = load_view_column(&tx, view_id, &c.column_id)?;
                    tx.execute(
                        r#"UPDATE "_meta" SET
                             "position" = ?1, "width" = ?2, "hidden" = ?3, "frozen" = ?4
                           WHERE "id" = ?5 AND "kind" = 'view_column'"#,
                        rusqlite::params![
                            c.position.unwrap_or(target.position),
                            c.width.unwrap_or(target.width),
                            c.hidden.unwrap_or(target.hidden) as i64,
                            c.frozen.unwrap_or(target.frozen) as i64,
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
                r#"UPDATE "_meta" SET "width" = ?1, "hidden" = ?2, "frozen" = ?3
                   WHERE "id" = ?4 AND "kind" = 'view_column'"#,
                rusqlite::params![
                    patch.width.unwrap_or(target.width),
                    patch.hidden.unwrap_or(target.hidden) as i64,
                    patch.frozen.unwrap_or(target.frozen) as i64,
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
