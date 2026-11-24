//! Table / column operations on [`Workspace`].
//!
//! Every operation runs inside a single transaction (铁律 1). Physical DDL is
//! always derived from the `_meta` node tree; shape changes (type / choices /
//! formula) go through the 12-step table rebuild with `foreign_keys=OFF`.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use super::column::{
    column_def_sql, conversion_expr, create_junction_ddl, create_table_ddl, drop_junction_ddl,
    formula_dependency_error, formula_dependents, rebuild_table, truncate_junction_to_single,
};
use super::fts;
use super::ident::{
    new_id, now_iso, quote_ident, quote_literal, table_sql_name, validate_user_name,
};
use super::{
    build_column_meta, insert_column_node, insert_node, insert_table_node, load_column,
    load_columns, load_table, next_position, normalize_color, normalize_icon, touch_table,
    validate_default_value, ColumnData, ColumnMeta, ColumnPatch, ColumnType, FormulaData,
    FormulaResultType, NewChoice, NewColumn, OptionMeta, RelationData, TableMeta,
};
use crate::db::Workspace;
use crate::error::{AppError, Result};

pub(crate) const MAX_COLUMNS: usize = 200;

/// Map SQLite constraint failures onto semantic [`AppError`] variants so the
/// UI can show meaningful messages.
pub(crate) fn map_sqlite_err(e: rusqlite::Error) -> AppError {
    if let rusqlite::Error::SqliteFailure(err, Some(msg)) = &e {
        const SQLITE_CONSTRAINT_UNIQUE: i32 = 19 | (8 << 8);
        const SQLITE_CONSTRAINT_PRIMARYKEY: i32 = 19 | (6 << 8);
        const SQLITE_CONSTRAINT_CHECK: i32 = 19 | (1 << 8);
        const SQLITE_CONSTRAINT_NOTNULL: i32 = 19 | (5 << 8);
        const SQLITE_CONSTRAINT_FOREIGNKEY: i32 = 19 | (3 << 8);
        return match err.extended_code {
            SQLITE_CONSTRAINT_UNIQUE | SQLITE_CONSTRAINT_PRIMARYKEY => {
                AppError::AlreadyExists(msg.clone())
            }
            SQLITE_CONSTRAINT_CHECK | SQLITE_CONSTRAINT_NOTNULL => {
                AppError::InvalidInput(format!("值不满足列约束: {msg}"))
            }
            SQLITE_CONSTRAINT_FOREIGNKEY => AppError::Rejected(msg.clone()),
            _ => AppError::Sqlite(e),
        };
    }
    AppError::Sqlite(e)
}

fn ensure_column_name_free(
    conn: &Connection,
    table_id: &str,
    name: &str,
    exclude_col_id: Option<&str>,
) -> Result<()> {
    let taken: bool = match exclude_col_id {
        Some(excl) => conn
            .query_row(
                r#"SELECT 1 FROM "_meta"
                   WHERE "parent_id" = ?1 AND "kind" = 'column' AND "name" = ?2 AND "id" != ?3"#,
                rusqlite::params![table_id, name, excl],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
        None => conn
            .query_row(
                r#"SELECT 1 FROM "_meta"
                   WHERE "parent_id" = ?1 AND "kind" = 'column' AND "name" = ?2"#,
                rusqlite::params![table_id, name],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
    };
    if taken {
        return Err(AppError::AlreadyExists(format!("列名 {name}")));
    }
    Ok(())
}

fn ensure_table_name_free(conn: &Connection, name: &str, exclude_id: Option<&str>) -> Result<()> {
    let taken: bool = match exclude_id {
        Some(excl) => conn
            .query_row(
                r#"SELECT 1 FROM "_meta"
                   WHERE "kind" = 'table' AND "name" = ?1 AND "id" != ?2"#,
                rusqlite::params![name, excl],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
        None => conn
            .query_row(
                r#"SELECT 1 FROM "_meta" WHERE "kind" = 'table' AND "name" = ?1"#,
                [name],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
    };
    if taken {
        return Err(AppError::AlreadyExists(format!("表名 {name}")));
    }
    Ok(())
}

/// Append a view-column node for `column` to every grid view of `table_id`
/// that does not have one yet.
fn sync_view_columns_for_new_column(
    conn: &Connection,
    table_id: &str,
    column: &ColumnMeta,
) -> Result<()> {
    let mut stmt = conn.prepare(
        r#"SELECT "id" FROM "_meta"
           WHERE "kind" = 'view' AND "view_kind" = 'grid' AND "parent_id" = ?1"#,
    )?;
    let view_ids: Vec<String> = stmt
        .query_map([table_id], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    drop(stmt);
    for view_id in view_ids {
        let exists: bool = conn
            .query_row(
                r#"SELECT 1 FROM "_meta"
                   WHERE "kind" = 'view_column' AND "parent_id" = ?1 AND "ref_id" = ?2"#,
                rusqlite::params![view_id, column.id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if exists {
            continue;
        }
        let position = next_position(conn, Some(&view_id), "view_column")?;
        let id = new_id();
        super::insert_view_column(
            conn,
            &view_id,
            &id,
            &column.id,
            position,
            column.width,
            false,
            false,
        )?;
    }
    Ok(())
}

/// SQL views whose stored statement mentions `needle` (a physical name).
fn sql_view_dependents(conn: &Connection, needle: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        r#"SELECT "name", "statement" FROM "_meta"
           WHERE "kind" = 'view' AND "view_kind" = 'sql'"#,
    )?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|(_, s)| s.as_deref().is_some_and(|s| s.contains(needle)))
        .map(|(name, _)| name)
        .collect())
}

/// Create the junction table (and optional reverse column) for a relation
/// column that has already been inserted into `_meta`.
fn setup_relation(
    conn: &Connection,
    src_table: &TableMeta,
    col: &ColumnMeta,
    reverse_name: Option<&str>,
) -> Result<()> {
    let rel = col
        .relation()
        .ok_or_else(|| AppError::Internal("setup_relation 收到了非关联列".into()))?;
    let target = load_table(conn, &rel.target_table_id)?;
    conn.execute_batch(&create_junction_ddl(
        &col.id,
        &src_table.sql_name,
        &target.sql_name,
    ))?;

    // The reverse name is a creation-only input (NewColumn), never persisted
    // as part of RelationData.
    if let Some(reverse_name) = reverse_name {
        let reverse_name = validate_user_name("反向列名", reverse_name)?;
        ensure_column_name_free(conn, &target.id, &reverse_name, None)?;
        let rid = new_id();
        let reverse = ColumnMeta {
            id: rid,
            table_id: target.id.clone(),
            name: reverse_name,
            position: next_position(conn, Some(&target.id), "column")?,
            width: 160,
            icon: None,
            color: None,
            align: None,
            default_value: None,
            format: None,
            created_at: now_iso(),
            data: ColumnData::Relation(RelationData {
                target_table_id: src_table.id.clone(),
                single: false,
                origin_id: Some(col.id.clone()),
            }),
        };
        insert_column_node(conn, &reverse)?;
        sync_view_columns_for_new_column(conn, &target.id, &reverse)?;
        touch_table(conn, &target.id)?;
    }
    Ok(())
}

/// Create a table inside an existing transaction.
///
/// Shared by [`Workspace::create_table`] and CSV import so both go through the
/// same validation and DDL path (铁律 1: callers own the transaction).
pub(crate) fn create_table_tx(
    conn: &Connection,
    name: &str,
    columns: Vec<NewColumn>,
    icon: Option<&str>,
) -> Result<TableMeta> {
    let name = validate_user_name("表名", name)?;
    let icon = super::normalize_icon(icon)?;
    if columns.is_empty() {
        return Err(AppError::InvalidInput("表至少需要一列".into()));
    }
    if columns.len() > MAX_COLUMNS {
        return Err(AppError::InvalidInput(format!(
            "列数超过上限（{MAX_COLUMNS}）"
        )));
    }
    if columns[0].col_type != ColumnType::Text {
        return Err(AppError::InvalidInput(
            "第一列必须是文本列（作为标题列）".into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for c in &columns {
        let n = validate_user_name("列名", &c.name)?;
        if !seen.insert(n) {
            return Err(AppError::AlreadyExists(format!("列名 {}", c.name)));
        }
    }

    ensure_table_name_free(conn, &name, None)?;
    // Relation targets must already exist (a table cannot relate to itself
    // during creation).
    for c in &columns {
        if c.col_type == ColumnType::Relation {
            let target_id = c
                .target_table_id
                .as_ref()
                .ok_or_else(|| AppError::InvalidInput("关联列必须提供目标表".into()))?;
            load_table(conn, target_id)?;
        }
    }

    let table_id = new_id();
    let sql_name = table_sql_name(&table_id);
    let position = next_position(conn, None, "table")?;
    let now = now_iso();

    let mut metas = Vec::with_capacity(columns.len());
    for (i, c) in columns.iter().enumerate() {
        let meta = build_column_meta(&table_id, c, i as i64)?;
        if let Some(default) = &meta.default_value {
            validate_default_value(conn, &meta, default)?;
        }
        metas.push(meta);
    }
    // Validate formulas against the full column set before writing anything.
    for m in &metas {
        if m.col_type() == ColumnType::Formula {
            column_def_sql(m, &metas)?;
        }
    }
    let title_col_id = metas[0].id.clone();

    let table = TableMeta {
        id: table_id.clone(),
        name,
        sql_name,
        // `title_col_id` is a self-FK; the column row does not exist yet, so
        // it is filled in after the column nodes are inserted.
        title_col_id: None,
        icon,
        color: None,
        position,
        created_at: now.clone(),
        updated_at: now,
    };
    insert_table_node(conn, &table)?;
    for m in &metas {
        insert_column_node(conn, m)?;
    }
    conn.execute(
        r#"UPDATE "_meta" SET "title_col_id" = ?1 WHERE "id" = ?2 AND "kind" = 'table'"#,
        rusqlite::params![title_col_id, table_id],
    )?;

    conn.execute_batch(&create_table_ddl(&table.sql_name, &metas)?)?;
    for (m, c) in metas.iter().zip(columns.iter()) {
        if m.col_type() == ColumnType::Relation {
            setup_relation(conn, &table, m, c.reverse_name.as_deref())?;
        }
    }

    let loaded = load_table(conn, &table_id)?;
    fts::rebuild(conn, &loaded, &metas)?;
    Ok(loaded)
}

impl Workspace {
    // ------------------------------------------------------------------
    // Tables
    // ------------------------------------------------------------------

    /// Create a table with its initial columns.
    pub fn create_table(&self, name: &str, columns: Vec<NewColumn>) -> Result<TableMeta> {
        self.with_tx(|conn| create_table_tx(conn, name, columns, None))
    }

    /// Create a table with its presentation emoji in the same transaction.
    pub fn create_table_with_icon(
        &self,
        name: &str,
        columns: Vec<NewColumn>,
        icon: Option<&str>,
    ) -> Result<TableMeta> {
        self.with_tx(|conn| create_table_tx(conn, name, columns, icon))
    }

    pub fn list_tables(&self) -> Result<Vec<TableMeta>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                r#"SELECT {} FROM "_meta" WHERE "kind" = 'table'
                   ORDER BY "position", "created_at""#,
                super::META_COLS
            ))?;
            let rows = stmt.query_map([], |r| {
                super::raw_from_row(r).and_then(super::table_from_raw)
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
    }

    pub fn get_table(&self, table_id: &str) -> Result<TableMeta> {
        self.with_conn(|conn| load_table(conn, table_id))
    }

    /// Rename a table (metadata only — the physical name never changes).
    pub fn rename_table(&self, table_id: &str, new_name: &str) -> Result<TableMeta> {
        let new_name = validate_user_name("表名", new_name)?;
        self.with_tx(|conn| {
            load_table(conn, table_id)?;
            ensure_table_name_free(conn, &new_name, Some(table_id))?;
            conn.execute(
                r#"UPDATE "_meta" SET "name" = ?1, "updated_at" = ?2
                   WHERE "id" = ?3 AND "kind" = 'table'"#,
                rusqlite::params![new_name, now_iso(), table_id],
            )
            .map_err(map_sqlite_err)?;
            load_table(conn, table_id)
        })
    }

    /// Delete a table and everything attached to it: physical table, FTS
    /// index, its junction tables, relation columns *in other tables* that
    /// target it (plus their reverse columns), and its views.
    ///
    /// Refuses when a SQL view references the table (铁律: no silently broken
    /// views) — the message lists the offending views.
    pub fn delete_table(&self, table_id: &str) -> Result<()> {
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;

            // 1. Reject if any SQL view depends on this table's physical name.
            let dependents = sql_view_dependents(conn, &table.sql_name)?;
            if !dependents.is_empty() {
                return Err(AppError::Rejected(format!(
                    "以下 SQL 视图依赖该表：{}；请先删除这些视图",
                    dependents.join("、")
                )));
            }

            // 2. Outbound relations of this table: drop their junctions. The
            //    reverse columns in other tables disappear through the
            //    `origin_id` cascade.
            for col in load_columns(conn, table_id)? {
                if col.col_type() == ColumnType::Relation && !col.is_reverse() {
                    conn.execute_batch(&drop_junction_ddl(&col.id))?;
                }
            }

            // 3. Inbound relations from other tables targeting this table:
            //    their metadata cascades via `target_table_id`, but their
            //    physical junction tables must be dropped explicitly.
            let mut stmt = conn.prepare(
                r#"SELECT "id" FROM "_meta"
                   WHERE "kind" = 'column' AND "col_type" = 'relation'
                     AND "parent_id" != ?1 AND "target_table_id" = ?1"#,
            )?;
            let inbound: Vec<String> = stmt
                .query_map([table_id], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            for col_id in inbound {
                conn.execute_batch(&drop_junction_ddl(&col_id))?;
            }

            // 4. FTS index (triggers die with the table), physical table,
            //    metadata node (cascades to columns/options/views/view
            //    columns and inbound relations).
            fts::drop(conn, &table.sql_name)?;
            conn.execute_batch(&format!("DROP TABLE {}", quote_ident(&table.sql_name)))?;
            conn.execute(
                r#"DELETE FROM "_meta" WHERE "id" = ?1 AND "kind" = 'table'"#,
                [table_id],
            )?;
            Ok(())
        })
    }

    /// Designate the title column (must be a non-reverse text column).
    pub fn set_title_column(&self, table_id: &str, col_id: &str) -> Result<TableMeta> {
        self.with_tx(|conn| {
            let col = load_column(conn, table_id, col_id)?;
            if col.col_type() != ColumnType::Text || col.is_reverse() {
                return Err(AppError::Rejected("标题列必须是文本列".into()));
            }
            conn.execute(
                r#"UPDATE "_meta" SET "title_col_id" = ?1, "updated_at" = ?2
                   WHERE "id" = ?3 AND "kind" = 'table'"#,
                rusqlite::params![col_id, now_iso(), table_id],
            )?;
            load_table(conn, table_id)
        })
    }

    /// Set or clear the table's emoji icon (presentation only, no DDL).
    pub fn set_table_icon(&self, table_id: &str, icon: Option<&str>) -> Result<TableMeta> {
        let icon = super::normalize_icon(icon)?;
        self.with_tx(|conn| {
            load_table(conn, table_id)?;
            conn.execute(
                r#"UPDATE "_meta" SET "icon" = ?1, "updated_at" = ?2
                   WHERE "id" = ?3 AND "kind" = 'table'"#,
                rusqlite::params![icon, now_iso(), table_id],
            )?;
            load_table(conn, table_id)
        })
    }

    /// Set or clear the table's palette color (presentation only).
    pub fn set_table_color(&self, table_id: &str, color: Option<&str>) -> Result<TableMeta> {
        let color = normalize_color(color)?;
        self.with_tx(|conn| {
            load_table(conn, table_id)?;
            conn.execute(
                r#"UPDATE "_meta" SET "color" = ?1, "updated_at" = ?2
                   WHERE "id" = ?3 AND "kind" = 'table'"#,
                rusqlite::params![color.as_ref().map(|c| c.as_str()), now_iso(), table_id],
            )?;
            load_table(conn, table_id)
        })
    }

    // ------------------------------------------------------------------
    // Columns
    // ------------------------------------------------------------------

    pub fn list_columns(&self, table_id: &str) -> Result<Vec<ColumnMeta>> {
        self.with_conn(|conn| load_columns(conn, table_id))
    }

    /// Append a new column to a table.
    pub fn add_column(&self, table_id: &str, col: NewColumn) -> Result<ColumnMeta> {
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let existing = load_columns(conn, table_id)?;
            if existing.len() >= MAX_COLUMNS {
                return Err(AppError::InvalidInput(format!(
                    "列数超过上限（{MAX_COLUMNS}）"
                )));
            }
            let meta = build_column_meta(table_id, &col, next_position(conn, Some(table_id), "column")?)?;
            ensure_column_name_free(conn, table_id, &meta.name, None)?;
            if meta.col_type() == ColumnType::Relation {
                let target_id = &meta
                    .relation()
                    .ok_or_else(|| AppError::Internal("关联列缺少关联数据".into()))?
                    .target_table_id;
                load_table(conn, target_id)?;
            }
            if let Some(default) = &meta.default_value {
                validate_default_value(conn, &meta, default)?;
            }
            // Validate formulas against the current set plus the new column.
            if meta.col_type() == ColumnType::Formula {
                let mut all = existing.clone();
                all.push(meta.clone());
                column_def_sql(&meta, &all)?;
            }

            insert_column_node(conn, &meta)?;

            if meta.col_type() == ColumnType::Relation {
                setup_relation(conn, &table, &meta, col.reverse_name.as_deref())?;
            } else if let Some(def) = column_def_sql(&meta, &existing)? {
                conn.execute_batch(&format!(
                    "ALTER TABLE {} ADD COLUMN {}",
                    quote_ident(&table.sql_name),
                    def
                ))?;
            }

            sync_view_columns_for_new_column(conn, table_id, &meta)?;

            // First text column becomes the title column if none is set.
            if table.title_col_id.is_none() && meta.col_type() == ColumnType::Text {
                conn.execute(
                    r#"UPDATE "_meta" SET "title_col_id" = ?1 WHERE "id" = ?2 AND "kind" = 'table'"#,
                    rusqlite::params![meta.id, table_id],
                )?;
            }
            if meta.col_type().is_searchable() {
                let cols = load_columns(conn, table_id)?;
                fts::rebuild(conn, &table, &cols)?;
            }
            touch_table(conn, table_id)?;
            Ok(meta)
        })
    }

    /// Update a column's name/type/options/presentation.
    pub fn update_column(
        &self,
        table_id: &str,
        col_id: &str,
        patch: ColumnPatch,
    ) -> Result<ColumnMeta> {
        self.with_conn(|conn| {
            let table = load_table(conn, table_id)?;
            let old = load_column(conn, table_id, col_id)?;
            let all = load_columns(conn, table_id)?;

            let new_type = patch.col_type.unwrap_or(old.col_type());
            let name = match &patch.name {
                Some(n) => validate_user_name("列名", n)?,
                None => old.name.clone(),
            };
            if name != old.name {
                ensure_column_name_free(conn, table_id, &name, Some(col_id))?;
            }

            if old.is_reverse()
                && (patch.col_type.is_some()
                    || patch.choices.is_some()
                    || patch.target_table_id.is_some()
                    || patch.single.is_some()
                    || patch.formula_expr.is_some()
                    || patch.formula_result_type.is_some())
            {
                return Err(AppError::Rejected(
                    "反向关联列只能修改名称/宽度/可见性/位置".into(),
                ));
            }
            if new_type != old.col_type() {
                if table.title_col_id.as_deref() == Some(col_id) {
                    return Err(AppError::Rejected(
                        "标题列必须保持文本类型；请先更换标题列".into(),
                    ));
                }
                if old.col_type() == ColumnType::Relation || new_type == ColumnType::Relation {
                    return Err(AppError::Rejected(
                        "不支持改为/改离关联列，请删除后重建".into(),
                    ));
                }
            }

            // Formula columns break on a type change of a column they use.
            if new_type != old.col_type() {
                let dependents = formula_dependents(&all, &old)?;
                let dependents: Vec<String> =
                    dependents.into_iter().filter(|n| *n != old.name).collect();
                if !dependents.is_empty() {
                    return Err(formula_dependency_error(&old.name, &dependents));
                }
            }

            // ---- compute the new polymorphic payload --------------------
            let old_choices = old.choices().to_vec();
            let (new_data, choices_patch, renames) = match new_type {
                ColumnType::Relation => {
                    let rel = old.relation().ok_or_else(|| {
                        AppError::Rejected("不支持改为关联列，请删除后重建".into())
                    })?;
                    let target = patch
                        .target_table_id
                        .clone()
                        .unwrap_or_else(|| rel.target_table_id.clone());
                    if target != rel.target_table_id {
                        load_table(conn, &target)?;
                    }
                    (
                        ColumnData::Relation(RelationData {
                            target_table_id: target,
                            single: patch.single.unwrap_or(rel.single),
                            origin_id: rel.origin_id.clone(),
                        }),
                        false,
                        Vec::new(),
                    )
                }
                ColumnType::Formula => {
                    let sql_name = old
                        .sql_name()
                        .ok_or_else(|| AppError::Internal("公式列缺少物理名".into()))?
                        .to_string();
                    let (expr, result_type) = match old.formula() {
                        Some(f) => (
                            patch.formula_expr.clone().unwrap_or_else(|| f.expr.clone()),
                            patch.formula_result_type.unwrap_or(f.result_type),
                        ),
                        None => (
                            patch
                                .formula_expr
                                .clone()
                                .filter(|s| !s.trim().is_empty())
                                .ok_or_else(|| AppError::InvalidInput("公式不能为空".into()))?,
                            patch.formula_result_type.unwrap_or(FormulaResultType::Number),
                        ),
                    };
                    (
                        ColumnData::Formula(FormulaData {
                            sql_name,
                            expr,
                            result_type,
                        }),
                        false,
                        Vec::new(),
                    )
                }
                ColumnType::Select | ColumnType::MultiSelect => {
                    let sql_name = old
                        .sql_name()
                        .ok_or_else(|| AppError::Internal("选项列缺少物理名".into()))?
                        .to_string();
                    let keep = matches!(
                        old.col_type(),
                        ColumnType::Select | ColumnType::MultiSelect
                    );
                    let mut choices = if keep { old_choices.clone() } else { Vec::new() };
                    let mut renames = Vec::new();
                    let mut patched = false;
                    if let Some(input) = &patch.choices {
                        let (next, r) =
                            sync_choices(conn, col_id, &old_choices, input)?;
                        choices = next;
                        renames = r;
                        patched = true;
                    }
                    let data = if new_type == ColumnType::Select {
                        ColumnData::Select { sql_name, choices }
                    } else {
                        ColumnData::MultiSelect { sql_name, choices }
                    };
                    (data, patched, renames)
                }
                _ => {
                    let sql_name = old
                        .sql_name()
                        .ok_or_else(|| AppError::Internal("列缺少物理名".into()))?
                        .to_string();
                    let data = match new_type {
                        ColumnType::Text => ColumnData::Text { sql_name },
                        ColumnType::Number => ColumnData::Number { sql_name },
                        ColumnType::Date => ColumnData::Date { sql_name },
                        ColumnType::Checkbox => ColumnData::Checkbox { sql_name },
                        _ => unreachable!(),
                    };
                    // Leaving select/multi: its option nodes are dead.
                    if matches!(
                        old.col_type(),
                        ColumnType::Select | ColumnType::MultiSelect
                    ) {
                        conn.execute(
                            r#"DELETE FROM "_meta" WHERE "parent_id" = ?1 AND "kind" = 'option'"#,
                            [col_id],
                        )?;
                    }
                    (data, false, Vec::new())
                }
            };

            let new_choices = new_data.choices().to_vec();
            let type_changed = new_type != old.col_type();
            let choices_changed = choices_patch
                || (type_changed
                    && matches!(
                        (old.col_type(), new_type),
                        (ColumnType::Select, ColumnType::MultiSelect)
                            | (ColumnType::MultiSelect, ColumnType::Select)
                    ));
            let formula_changed = old.formula().is_some()
                && new_data
                    .formula()
                    .is_some_and(|f| old.formula() != Some(f));

            let relation_target_changed = old
                .relation()
                .zip(new_data.relation())
                .is_some_and(|(a, b)| a.target_table_id != b.target_table_id);
            let relation_single_tightened = old
                .relation()
                .zip(new_data.relation())
                .is_some_and(|(a, b)| !a.single && b.single);

            let mut new_meta = ColumnMeta {
                name,
                align: match &patch.align {
                    Some(raw) => super::normalize_column_align(Some(raw))?,
                    None => old.align,
                },
                icon: match &patch.icon {
                    Some(raw) => super::normalize_icon(Some(raw))?,
                    None => old.icon.clone(),
                },
                color: match &patch.color {
                    Some(raw) => super::normalize_column_color(Some(raw))?,
                    None => old.color.clone(),
                },
                default_value: match &patch.default_value {
                    Some(v) if v.is_null() => None,
                    Some(v) => Some(v.clone()),
                    None => old.default_value.clone(),
                },
                data: new_data,
                ..old.clone()
            };
            if patch.clear_default {
                new_meta.default_value = None;
            }

            // Presentation format is tied to the effective value type: an
            // explicit clear always wins, and an inherited format is dropped
            // when a type change makes it meaningless.
            let effective_type = new_meta.effective_type();
            if patch.clear_format {
                new_meta.format = None;
            } else if let Some(format) = &patch.format {
                format.validate(effective_type)?;
                new_meta.format = Some(format.clone());
            } else if new_meta
                .format
                .as_ref()
                .is_some_and(|f| !f.allows(effective_type))
            {
                new_meta.format = None;
            }

            let explicit_default = !patch.clear_default
                && patch.default_value.as_ref().is_some_and(|v| !v.is_null());
            if let Some(default) = new_meta.default_value.clone() {
                if explicit_default {
                    validate_default_value(conn, &new_meta, &default)?;
                } else if (new_type != old.col_type() || choices_changed)
                    && validate_default_value(conn, &new_meta, &default).is_err()
                {
                    new_meta.default_value = None;
                }
            }

            let needs_rebuild = type_changed || choices_changed || formula_changed;

            run_in_tx_maybe_fk_off(conn, needs_rebuild, |tx| {
                // 1. metadata row
                let (formula_expr, formula_result_type) = match &new_meta.data {
                    ColumnData::Formula(f) => {
                        (Some(f.expr.as_str()), Some(f.result_type.as_str()))
                    }
                    _ => (None, None),
                };
                let (target, single) = match &new_meta.data {
                    ColumnData::Relation(r) => {
                        (Some(r.target_table_id.as_str()), Some(r.single as i64))
                    }
                    _ => (None, None),
                };
                tx.execute(
                    r#"UPDATE "_meta" SET
                         "name" = ?1, "col_type" = ?2, "width" = ?3, "icon" = ?4,
                         "color" = ?5, "align" = ?6, "default_value" = ?7,
                         "target_table_id" = ?8, "single" = ?9,
                         "formula_expr" = ?10, "formula_result_type" = ?11,
                         "format" = ?12, "updated_at" = ?13
                       WHERE "id" = ?14 AND "kind" = 'column'"#,
                    rusqlite::params![
                        new_meta.name,
                        new_meta.col_type().as_str(),
                        new_meta.width,
                        new_meta.icon,
                        new_meta.color.as_ref().map(|c| c.as_str()),
                        new_meta.align.map(|a| a.as_str()),
                        new_meta
                            .default_value
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?,
                        target,
                        single,
                        formula_expr,
                        formula_result_type,
                        new_meta
                            .format
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?,
                        now_iso(),
                        col_id,
                    ],
                )
                .map_err(map_sqlite_err)?;

                // 2. relation-specific junction maintenance
                if relation_target_changed {
                    tx.execute_batch(&drop_junction_ddl(col_id))?;
                    tx.execute(
                        r#"DELETE FROM "_meta" WHERE "origin_id" = ?1"#,
                        [col_id],
                    )?;
                    let fresh = load_column(tx, table_id, col_id)?;
                    setup_relation(tx, &table, &fresh, None)?;
                } else if relation_single_tightened {
                    tx.execute_batch(&truncate_junction_to_single(col_id))?;
                }

                // 3. rebuild the physical table when its shape changed
                if needs_rebuild {
                    let cols = load_columns(tx, table_id)?;
                    let mut conversions = HashMap::new();
                    if (type_changed || choices_changed)
                        && new_meta.is_physical()
                        && old.is_physical()
                    {
                        let old_sql = old.sql_name().unwrap_or_default();
                        let base = quote_ident(old_sql);
                        let renamed = select_rename_expr(&renames, &base);
                        let source = match (old.col_type(), new_type) {
                            (ColumnType::Select, ColumnType::MultiSelect) => format!(
                                "CASE WHEN {renamed} IS NULL THEN '[]' ELSE json_array({renamed}) END"
                            ),
                            (ColumnType::MultiSelect, ColumnType::Select) => format!(
                                "CASE WHEN json_valid({base}) AND json_array_length({base}) > 0 \
                                     THEN json_extract({base}, '$[0]') ELSE NULL END"
                            ),
                            (ColumnType::Checkbox, ColumnType::Text) => format!(
                                "CASE {base} WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE NULL END"
                            ),
                            _ => renamed,
                        };
                        let expr = conversion_expr(new_type, &new_choices, &source)?;
                        conversions.insert(old_sql.to_string(), expr);
                    }
                    rebuild_table(tx, &table, &cols, &conversions)?;
                }

                // 4. presentation: reorder if requested
                if let Some(target) = patch.position {
                    reorder(tx, table_id, col_id, target)?;
                }
                touch_table(tx, table_id)?;
                load_column(tx, table_id, col_id)
            })
        })
    }

    /// Delete a column.
    ///
    /// Refuses for the title column, for columns referenced by formula
    /// columns, and for columns referenced by a SQL view. Relation columns
    /// drop their junction table and all reverse columns in the same
    /// transaction (铁律 6).
    pub fn delete_column(&self, table_id: &str, col_id: &str) -> Result<()> {
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let col = load_column(conn, table_id, col_id)?;
            if table.title_col_id.as_deref() == Some(col_id) {
                return Err(AppError::Rejected("不能删除标题列；请先更换标题列".into()));
            }
            if !col.is_reverse() {
                let all = load_columns(conn, table_id)?;
                let dependents = formula_dependents(&all, &col)?;
                if !dependents.is_empty() {
                    return Err(formula_dependency_error(&col.name, &dependents));
                }
            }
            if let Some(sql_name) = col.sql_name() {
                let dependents = sql_view_dependents(conn, sql_name)?;
                if !dependents.is_empty() {
                    return Err(AppError::Rejected(format!(
                        "以下 SQL 视图依赖该列：{}；请先删除这些视图",
                        dependents.join("、")
                    )));
                }
            }

            if col.col_type() == ColumnType::Relation && !col.is_reverse() {
                // 铁律 6: junction table + reverse columns, same tx. Reverse
                // metadata also cascades through `origin_id`.
                conn.execute_batch(&drop_junction_ddl(col_id))?;
                conn.execute(r#"DELETE FROM "_meta" WHERE "origin_id" = ?1"#, [col_id])?;
            }
            conn.execute(
                r#"DELETE FROM "_meta" WHERE "id" = ?1 AND "kind" = 'column'"#,
                [col_id],
            )?;

            if col.is_physical() {
                if col.col_type().is_searchable() {
                    // Rebuild FTS first so no trigger references the column
                    // when it is dropped (SQLite would refuse the DROP).
                    let cols = load_columns(conn, table_id)?;
                    fts::rebuild(conn, &table, &cols)?;
                }
                conn.execute_batch(&format!(
                    "ALTER TABLE {} DROP COLUMN {}",
                    quote_ident(&table.sql_name),
                    quote_ident(col.sql_name().unwrap_or_default())
                ))?;
            }
            touch_table(conn, table_id)?;
            Ok(())
        })
    }

    /// True physical columns of a table (debug/introspection helper).
    pub fn physical_columns(&self, table_id: &str) -> Result<Vec<(String, String)>> {
        self.with_conn(|conn| {
            let table = load_table(conn, table_id)?;
            let mut stmt = conn.prepare(&format!(
                "PRAGMA table_info({})",
                quote_ident(&table.sql_name)
            ))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
                .collect::<std::result::Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Names of SQLite objects matching a LIKE pattern (test helper).
    pub fn schema_objects(&self, like: &str) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT name FROM sqlite_master WHERE name LIKE ?1 ORDER BY name")?;
            let rows = stmt.query_map([like], |r| r.get(0))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
    }
}

/// Build the expression used to rewrite an old select value into the new
/// choice set, preserving renames (matched by stable option id).
fn select_rename_expr(renames: &[(String, String)], x: &str) -> String {
    if renames.is_empty() {
        return x.to_string();
    }
    let mut arms = String::new();
    for (old, new) in renames {
        if let (Ok(o), Ok(n)) = (quote_literal(old), quote_literal(new)) {
            arms.push_str(&format!(" WHEN CAST({x} AS TEXT) = {o} THEN {n}"));
        }
    }
    format!("CASE{arms} ELSE {x} END")
}

/// New options plus the `(old name → new name)` map used to rewrite values.
type ChoiceSync = (Vec<OptionMeta>, Vec<(String, String)>);

/// Synchronize option rows with the patch's choice list. Returns the new
/// choices and the (old name → new name) rename map for value migration.
fn sync_choices(
    conn: &Connection,
    column_id: &str,
    old: &[OptionMeta],
    input: &[NewChoice],
) -> Result<ChoiceSync> {
    let old_by_id: HashMap<&str, &OptionMeta> = old.iter().map(|c| (c.id.as_str(), c)).collect();
    let old_by_name: HashMap<&str, &OptionMeta> =
        old.iter().map(|c| (c.name.as_str(), c)).collect();

    // Match each input choice to an existing row by stable id first, then by
    // name (covers clients that do not round-trip ids).
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut next = Vec::with_capacity(input.len());
    for (i, c) in input.iter().enumerate() {
        let name = validate_user_name("选项名", &c.name)?;
        let icon = normalize_icon(c.icon.as_deref())?;
        let color = normalize_color(c.color.as_deref())?;
        let requested = c.id.clone().filter(|s| !s.is_empty());
        let matched = requested
            .as_deref()
            .and_then(|id| old_by_id.get(id).copied())
            .or_else(|| {
                old_by_name
                    .get(name.as_str())
                    .copied()
                    .filter(|o| !claimed.contains(&o.id))
            });
        let id = matched
            .map(|o| o.id.clone())
            .or(requested)
            .unwrap_or_else(new_id);
        if !claimed.insert(id.clone()) {
            return Err(AppError::Internal("选项 id 重复".into()));
        }
        next.push(OptionMeta {
            id,
            name,
            icon,
            color,
            position: i as i64,
        });
    }
    // Unique names.
    let mut names = std::collections::HashSet::new();
    for c in &next {
        if !names.insert(c.name.clone()) {
            return Err(AppError::AlreadyExists(format!("选项 {}", c.name)));
        }
    }

    let keep: std::collections::HashSet<&str> = next.iter().map(|s| s.id.as_str()).collect();
    let mut renames = Vec::new();
    for c in &next {
        match old_by_id.get(c.id.as_str()) {
            Some(prev) => {
                if prev.name != c.name {
                    renames.push((prev.name.clone(), c.name.clone()));
                }
                conn.execute(
                    r#"UPDATE "_meta" SET "name" = ?1, "icon" = ?2, "color" = ?3, "position" = ?4
                       WHERE "id" = ?5 AND "kind" = 'option'"#,
                    rusqlite::params![
                        c.name,
                        c.icon,
                        c.color.as_ref().map(|v| v.as_str()),
                        c.position,
                        c.id
                    ],
                )?;
            }
            None => insert_node(
                conn,
                &c.id,
                Some(column_id),
                "option",
                Some(&c.name),
                c.position,
                c.icon.as_deref(),
                c.color.as_ref().map(|v| v.as_str()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )?,
        }
    }
    // Delete removed choices (and anything not in `keep`).
    let mut stmt =
        conn.prepare(r#"SELECT "id" FROM "_meta" WHERE "parent_id" = ?1 AND "kind" = 'option'"#)?;
    let existing: Vec<String> = stmt
        .query_map([column_id], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    drop(stmt);
    for id in existing {
        if !keep.contains(id.as_str()) {
            conn.execute(r#"DELETE FROM "_meta" WHERE "id" = ?1"#, [id])?;
        }
    }
    Ok((next, renames))
}

/// Reorder: move `col_id` to index `target` and renumber positions densely.
fn reorder(conn: &Connection, table_id: &str, col_id: &str, target: i64) -> Result<()> {
    let cols = load_columns(conn, table_id)?;
    let mut ids: Vec<String> = cols.iter().map(|c| c.id.clone()).collect();
    let idx = ids
        .iter()
        .position(|c| c == col_id)
        .ok_or_else(|| AppError::NotFound(format!("列 {col_id}")))?;
    let moved = ids.remove(idx);
    let target = target.clamp(0, ids.len() as i64) as usize;
    ids.insert(target, moved);
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            r#"UPDATE "_meta" SET "position" = ?1 WHERE "id" = ?2 AND "kind" = 'column'"#,
            rusqlite::params![i as i64, id],
        )?;
    }
    Ok(())
}

/// Run `f` in a transaction; when `fk_off` is set, follow the 12-step ALTER
/// procedure: `foreign_keys=OFF` outside the tx, integrity check afterwards.
fn run_in_tx_maybe_fk_off<R>(
    conn: &mut Connection,
    fk_off: bool,
    f: impl FnOnce(&Connection) -> Result<R>,
) -> Result<R> {
    if !fk_off {
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        return Ok(out);
    }
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let result: Result<R> = (|| {
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    })();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let out = result?;
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let violations = stmt.query_map([], |r| r.get::<_, i64>(0))?.count();
    if violations > 0 {
        return Err(AppError::Internal(format!(
            "外键完整性检查失败（{violations} 处违规）"
        )));
    }
    Ok(out)
}
