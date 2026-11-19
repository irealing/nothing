//! Table & column operations on [`Workspace`].
//!
//! Every operation runs inside a single transaction (铁律 1). Physical DDL is
//! always derived from the metadata tables; shape changes (type / choices /
//! formula) go through the 12-step table rebuild with `foreign_keys=OFF`
//! (see [`super::column::rebuild_table`]).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use super::column::{
    column_def_sql, conversion_expr, create_junction_ddl, create_table_ddl, drop_junction_ddl,
    formula_dependency_error, formula_dependents, rebuild_table, truncate_junction_to_single,
};
use super::fts;
use super::ident::{new_id, now_iso, quote_ident, table_sql_name, validate_user_name};
use super::{
    build_column_meta, load_column, load_columns, load_table, load_table_by_name, next_position,
    table_from_row, touch_table, ColumnMeta, ColumnOpts, ColumnPatch, ColumnType, NewColumn,
    TableMeta,
};
use crate::db::Workspace;
use crate::error::{AppError, Result};

const MAX_COLUMNS: usize = 200;

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
                r#"SELECT 1 FROM "_columns" WHERE "table_id" = ?1 AND "name" = ?2 AND "id" != ?3"#,
                rusqlite::params![table_id, name, excl],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
        None => conn
            .query_row(
                r#"SELECT 1 FROM "_columns" WHERE "table_id" = ?1 AND "name" = ?2"#,
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
                r#"SELECT 1 FROM "_tables" WHERE "name" = ?1 AND "id" != ?2"#,
                rusqlite::params![name, excl],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
        None => conn
            .query_row(
                r#"SELECT 1 FROM "_tables" WHERE "name" = ?1"#,
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

/// Create the junction table (and optional reverse column) for a relation
/// column that has already been inserted into `_columns`.
fn setup_relation(conn: &Connection, src_table: &TableMeta, col: &ColumnMeta) -> Result<()> {
    let opts = col.opts.relation()?;
    let target = load_table(conn, &opts.target_table_id)?;
    conn.execute_batch(&create_junction_ddl(
        &col.id,
        &src_table.sql_name,
        &target.sql_name,
    ))?;

    if let Some(reverse_name) = opts.reverse_name.as_deref() {
        let reverse_name = validate_user_name("反向列名", reverse_name)?;
        ensure_column_name_free(conn, &target.id, &reverse_name, None)?;
        let rid = new_id();
        let reverse = ColumnMeta {
            id: rid.clone(),
            table_id: target.id.clone(),
            name: reverse_name,
            // Reverse columns have no physical column; the name is generated
            // only to keep `_columns.sql_name` NOT NULL.
            sql_name: super::ident::column_sql_name(&rid),
            col_type: ColumnType::Relation,
            opts: ColumnOpts::Relation(super::RelationOpts {
                target_table_id: src_table.id.clone(),
                single: false,
                reverse_name: None,
            }),
            position: next_position(conn, &target.id)?,
            width: 160,
            visible: true,
            is_reverse: true,
            reverse_of: Some(col.id.clone()),
            created_at: now_iso(),
        };
        super::insert_column(conn, &reverse)?;
        touch_table(conn, &target.id)?;
    }
    Ok(())
}

impl Workspace {
    // ------------------------------------------------------------------
    // Tables
    // ------------------------------------------------------------------

    /// Create a table with its initial columns.
    ///
    /// The first column must be a text column — it becomes the table's title
    /// column (used by relation pickers as the row display name).
    pub fn create_table(&self, name: &str, columns: Vec<NewColumn>) -> Result<TableMeta> {
        let name = validate_user_name("表名", name)?;
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
            let opts = c
                .opts
                .clone()
                .unwrap_or_else(|| ColumnOpts::default_for(c.col_type));
            super::validate_opts(c.col_type, &opts)?;
        }

        self.with_tx(|conn| {
            ensure_table_name_free(conn, &name, None)?;
            // Relation targets must already exist (a table cannot relate to
            // itself during creation).
            for c in &columns {
                if c.col_type == ColumnType::Relation {
                    let opts = c
                        .opts
                        .as_ref()
                        .ok_or_else(|| AppError::InvalidInput("关联列必须提供选项".into()))?;
                    let target_id = &opts.relation()?.target_table_id;
                    load_table(conn, target_id)?;
                }
            }

            let table_id = new_id();
            let sql_name = table_sql_name(&table_id);
            let position: i64 = conn.query_row(
                r#"SELECT COALESCE(MAX("position"), -1) + 1 FROM "_tables""#,
                [],
                |r| r.get(0),
            )?;
            let now = now_iso();

            let mut metas = Vec::with_capacity(columns.len());
            for (i, c) in columns.iter().enumerate() {
                metas.push(build_column_meta(&table_id, c, i as i64)?);
            }
            let title_col_id = metas[0].id.clone();

            conn.execute(
                r#"INSERT INTO "_tables"
                     ("id","name","sql_name","title_col_id","icon","position","created_at","updated_at")
                   VALUES (?1,?2,?3,?4,NULL,?5,?6,?6)"#,
                rusqlite::params![table_id, name, sql_name, title_col_id, position, now],
            )
            .map_err(map_sqlite_err)?;
            for m in &metas {
                super::insert_column(conn, m)?;
            }

            conn.execute_batch(&create_table_ddl(&sql_name, &metas)?)?;
            for m in metas.iter().filter(|m| m.col_type == ColumnType::Relation) {
                let table_meta = TableMeta {
                    id: table_id.clone(),
                    name: name.clone(),
                    sql_name: sql_name.clone(),
                    title_col_id: Some(title_col_id.clone()),
                    icon: None,
                    position,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                };
                setup_relation(conn, &table_meta, m)?;
            }

            let table = load_table(conn, &table_id)?;
            fts::rebuild(conn, &table, &metas)?;
            Ok(table)
        })
    }

    pub fn list_tables(&self) -> Result<Vec<TableMeta>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                r#"SELECT {} FROM "_tables" ORDER BY "position", "created_at""#,
                super::TABLE_COLS
            ))?;
            let rows = stmt.query_map([], table_from_row)?;
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

    pub fn get_table_by_name(&self, name: &str) -> Result<TableMeta> {
        self.with_conn(|conn| load_table_by_name(conn, name))
    }

    /// Rename a table (metadata only — the physical name never changes).
    pub fn rename_table(&self, table_id: &str, new_name: &str) -> Result<TableMeta> {
        let new_name = validate_user_name("表名", new_name)?;
        self.with_tx(|conn| {
            load_table(conn, table_id)?;
            ensure_table_name_free(conn, &new_name, Some(table_id))?;
            conn.execute(
                r#"UPDATE "_tables" SET "name" = ?1, "updated_at" = ?2 WHERE "id" = ?3"#,
                rusqlite::params![new_name, now_iso(), table_id],
            )
            .map_err(map_sqlite_err)?;
            load_table(conn, table_id)
        })
    }

    /// Delete a table and everything attached to it: physical table, FTS
    /// index, its junction tables, relation columns *in other tables* that
    /// target it (plus their reverse columns), and its grid views.
    ///
    /// Refuses when a SQL view references the table (铁律: no silently broken
    /// views) — the message lists the offending views.
    pub fn delete_table(&self, table_id: &str) -> Result<()> {
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;

            // 1. Reject if any SQL view depends on this table's physical name.
            let mut stmt = conn
                .prepare(r#"SELECT "id", "name", "config" FROM "_views" WHERE "kind" = 'sql'"#)?;
            let sql_views: Vec<(String, String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            let dependents: Vec<String> = sql_views
                .iter()
                .filter(|(_, _, cfg)| cfg.contains(&table.sql_name))
                .map(|(_, name, _)| name.clone())
                .collect();
            if !dependents.is_empty() {
                return Err(AppError::Rejected(format!(
                    "以下 SQL 视图依赖该表：{}；请先删除这些视图",
                    dependents.join("、")
                )));
            }

            // 2. Outbound relations of this table: drop junctions and the
            //    reverse columns living in target tables.
            for col in load_columns(conn, table_id)? {
                if col.col_type == ColumnType::Relation && !col.is_reverse {
                    conn.execute_batch(&drop_junction_ddl(&col.id))?;
                    conn.execute(
                        r#"DELETE FROM "_columns" WHERE "reverse_of" = ?1"#,
                        [&col.id],
                    )?;
                }
            }

            // 3. Inbound relations from other tables targeting this table:
            //    drop their junctions, reverse columns and the columns themselves.
            let mut stmt = conn.prepare(
                r#"SELECT "id" FROM "_columns"
                   WHERE "type" = 'relation' AND "table_id" != ?1
                     AND json_extract("opts", '$.target_table_id') = ?1"#,
            )?;
            let inbound: Vec<String> = stmt
                .query_map([table_id], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            for col_id in inbound {
                conn.execute_batch(&drop_junction_ddl(&col_id))?;
                conn.execute(
                    r#"DELETE FROM "_columns" WHERE "id" = ?1 OR "reverse_of" = ?1"#,
                    [&col_id],
                )?;
            }

            // 4. FTS index (triggers die with the table), physical table,
            //    metadata row (cascades to _columns and grid _views).
            fts::drop(conn, &table.sql_name)?;
            conn.execute_batch(&format!("DROP TABLE {}", quote_ident(&table.sql_name)))?;
            conn.execute(r#"DELETE FROM "_tables" WHERE "id" = ?1"#, [table_id])?;
            Ok(())
        })
    }

    /// Designate the title column (must be a non-reverse text column).
    pub fn set_title_column(&self, table_id: &str, col_id: &str) -> Result<TableMeta> {
        self.with_tx(|conn| {
            let col = load_column(conn, table_id, col_id)?;
            if col.col_type != ColumnType::Text || col.is_reverse {
                return Err(AppError::Rejected("标题列必须是文本列".into()));
            }
            conn.execute(
                r#"UPDATE "_tables" SET "title_col_id" = ?1, "updated_at" = ?2 WHERE "id" = ?3"#,
                rusqlite::params![col_id, now_iso(), table_id],
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
            let meta = build_column_meta(table_id, &col, next_position(conn, table_id)?)?;
            ensure_column_name_free(conn, table_id, &meta.name, None)?;
            if meta.col_type == ColumnType::Relation {
                // Target must exist (self-relations are allowed here).
                let target_id = &meta.opts.relation()?.target_table_id;
                load_table(conn, target_id)?;
            }
            // Formula expressions are validated by column_def_sql below.
            super::insert_column(conn, &meta)?;

            if meta.col_type == ColumnType::Relation {
                setup_relation(conn, &table, &meta)?;
            } else if let Some(def) = column_def_sql(&meta, &existing)? {
                conn.execute_batch(&format!(
                    "ALTER TABLE {} ADD COLUMN {}",
                    quote_ident(&table.sql_name),
                    def
                ))?;
            }

            // First text column becomes the title column if none is set.
            if table.title_col_id.is_none() && meta.col_type == ColumnType::Text {
                conn.execute(
                    r#"UPDATE "_tables" SET "title_col_id" = ?1 WHERE "id" = ?2"#,
                    rusqlite::params![meta.id, table_id],
                )?;
            }
            if meta.col_type.is_searchable() {
                let cols = load_columns(conn, table_id)?;
                fts::rebuild(conn, &table, &cols)?;
            }
            touch_table(conn, table_id)?;
            Ok(meta)
        })
    }

    /// Update a column's name/type/options/presentation.
    ///
    /// Physical implications:
    /// - name/width/visible/position → metadata only (铁律 3)
    /// - type change / select-choices change / formula change → full table
    ///   rebuild with value conversion, inside a `foreign_keys=OFF`
    ///   transaction (铁律 2)
    /// - relation single/target change → junction truncate/recreate
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

            // --- compute the new metadata -------------------------------
            let new_type = patch.col_type.unwrap_or(old.col_type);
            let name = match &patch.name {
                Some(n) => validate_user_name("列名", n)?,
                None => old.name.clone(),
            };
            if name != old.name {
                ensure_column_name_free(conn, table_id, &name, Some(col_id))?;
            }

            if old.is_reverse && (patch.col_type.is_some() || patch.opts.is_some()) {
                return Err(AppError::Rejected(
                    "反向关联列只能修改名称/宽度/可见性/位置".into(),
                ));
            }
            if new_type != old.col_type {
                if table.title_col_id.as_deref() == Some(col_id) {
                    return Err(AppError::Rejected(
                        "标题列必须保持文本类型；请先更换标题列".into(),
                    ));
                }
                if old.col_type == ColumnType::Relation || new_type == ColumnType::Relation {
                    return Err(AppError::Rejected(
                        "不支持改为/改离关联列，请删除后重建".into(),
                    ));
                }
            }

            let new_opts = match (&patch.col_type, patch.opts.clone()) {
                (_, Some(opts)) => {
                    super::validate_opts(new_type, &opts)?;
                    opts
                }
                (Some(t), None) => ColumnOpts::migrated(&old.opts, *t),
                (None, None) => old.opts.clone(),
            };

            // --- classify physical impact --------------------------------
            let type_changed = new_type != old.col_type;
            let choices_changed = !type_changed
                && matches!(new_type, ColumnType::Select | ColumnType::MultiSelect)
                && new_opts != old.opts;
            let formula_changed =
                !type_changed && new_type == ColumnType::Formula && new_opts != old.opts;
            let needs_rebuild = type_changed || choices_changed || formula_changed;

            let relation_target_changed = new_type == ColumnType::Relation
                && !old.is_reverse
                && old.opts.relation()?.target_table_id != new_opts.relation()?.target_table_id;
            let relation_single_tightened = new_type == ColumnType::Relation
                && !old.is_reverse
                && !old.opts.relation()?.single
                && new_opts.relation()?.single;

            // Formula columns depending on this column break on type change.
            if type_changed {
                let dependents = formula_dependents(&all, &old)?;
                let dependents: Vec<String> =
                    dependents.into_iter().filter(|n| *n != old.name).collect();
                if !dependents.is_empty() {
                    return Err(formula_dependency_error(&old.name, &dependents));
                }
            }

            let new_meta = ColumnMeta {
                name: name.clone(),
                col_type: new_type,
                opts: new_opts.clone(),
                width: patch.width.unwrap_or(old.width),
                visible: patch.visible.unwrap_or(old.visible),
                ..old.clone()
            };

            // --- apply ----------------------------------------------------
            run_in_tx_maybe_fk_off(conn, needs_rebuild, |tx| {
                // 1. metadata first — rebuild derives DDL from metadata
                tx.execute(
                    r#"UPDATE "_columns"
                       SET "name" = ?1, "type" = ?2, "opts" = ?3, "width" = ?4, "visible" = ?5
                       WHERE "id" = ?6"#,
                    rusqlite::params![
                        new_meta.name,
                        new_meta.col_type.as_str(),
                        serde_json::to_string(&new_meta.opts)?,
                        new_meta.width,
                        new_meta.visible as i64,
                        col_id,
                    ],
                )
                .map_err(map_sqlite_err)?;

                // 2. relation-specific junction maintenance
                if relation_target_changed {
                    tx.execute_batch(&drop_junction_ddl(col_id))?;
                    // Old reverse columns pointed at the old target — remove.
                    tx.execute(
                        r#"DELETE FROM "_columns" WHERE "reverse_of" = ?1"#,
                        [col_id],
                    )?;
                    let fresh = load_column(tx, table_id, col_id)?;
                    setup_relation(tx, &table, &fresh)?;
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
                        let base = quote_ident(&old.sql_name);
                        // Preserve data across select ↔ multi_select.
                        let source = match (old.col_type, new_type) {
                            (ColumnType::Select, ColumnType::MultiSelect) => format!(
                                "CASE WHEN {base} IS NULL THEN '[]' ELSE json_array({base}) END"
                            ),
                            (ColumnType::MultiSelect, ColumnType::Select) => format!(
                                "CASE WHEN json_valid({base}) AND json_array_length({base}) > 0 \
                                     THEN json_extract({base}, '$[0]') ELSE NULL END"
                            ),
                            (ColumnType::Checkbox, ColumnType::Text) => format!(
                                "CASE {base} WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE NULL END"
                            ),
                            _ => base,
                        };
                        let expr = conversion_expr(new_type, &new_opts, &source)?;
                        conversions.insert(old.sql_name.clone(), expr);
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
    /// Refuses for the title column and for columns referenced by formula
    /// columns. Relation columns drop their junction table and all reverse
    /// columns in the same transaction (铁律 6).
    pub fn delete_column(&self, table_id: &str, col_id: &str) -> Result<()> {
        self.with_tx(|conn| {
            let table = load_table(conn, table_id)?;
            let col = load_column(conn, table_id, col_id)?;
            if table.title_col_id.as_deref() == Some(col_id) {
                return Err(AppError::Rejected("不能删除标题列；请先更换标题列".into()));
            }
            if !col.is_reverse {
                let all = load_columns(conn, table_id)?;
                let dependents = formula_dependents(&all, &col)?;
                if !dependents.is_empty() {
                    return Err(formula_dependency_error(&col.name, &dependents));
                }
            }

            if col.col_type == ColumnType::Relation && !col.is_reverse {
                // 铁律 6: junction table + all reverse columns, same tx.
                conn.execute_batch(&drop_junction_ddl(col_id))?;
                conn.execute(
                    r#"DELETE FROM "_columns" WHERE "reverse_of" = ?1"#,
                    [col_id],
                )?;
            }
            conn.execute(r#"DELETE FROM "_columns" WHERE "id" = ?1"#, [col_id])?;

            if col.is_physical() {
                if col.col_type.is_searchable() {
                    // Rebuild FTS first so no trigger references the column
                    // when it is dropped (SQLite would refuse the DROP).
                    let cols = load_columns(conn, table_id)?;
                    fts::rebuild(conn, &table, &cols)?;
                }
                conn.execute_batch(&format!(
                    "ALTER TABLE {} DROP COLUMN {}",
                    quote_ident(&table.sql_name),
                    quote_ident(&col.sql_name)
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
            let rows = stmt
                .query_map([like], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            Ok(rows)
        })
    }
}

/// Reorder: move `col_id` to index `target` and renumber positions densely.
fn reorder(conn: &Connection, table_id: &str, col_id: &str, target: i64) -> Result<()> {
    let mut cols = load_columns(conn, table_id)?;
    let idx = cols
        .iter()
        .position(|c| c.id == col_id)
        .ok_or_else(|| AppError::NotFound(format!("列 {col_id}")))?;
    let col = cols.remove(idx);
    let target = target.clamp(0, cols.len() as i64) as usize;
    cols.insert(target, col);
    for (i, c) in cols.iter().enumerate() {
        conn.execute(
            r#"UPDATE "_columns" SET "position" = ?1 WHERE "id" = ?2"#,
            rusqlite::params![i as i64, c.id],
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
