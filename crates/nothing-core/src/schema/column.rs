//! Physical DDL generation for columns, junction tables, and the table-rebuild
//! machinery used by type changes.

use std::collections::HashMap;

use rusqlite::Connection;

use super::formula::{self, ColumnRef};
use super::fts;
use super::ident::{junction_index_name, junction_sql_name, quote_ident, quote_literal};
use super::{ColumnData, ColumnMeta, ColumnType, FormulaResultType, OptionMeta, TableMeta};
use crate::error::{AppError, Result};

/// Resolver for formula compilation against a table's full column set.
/// Reverse columns are metadata-only and never referenceable.
pub(crate) fn formula_resolver(all: &[ColumnMeta]) -> impl Fn(&str) -> Option<ColumnRef> + '_ {
    move |name: &str| {
        all.iter()
            .find(|c| !c.is_reverse() && c.name == name)
            .map(|c| ColumnRef {
                sql_name: c.sql_name().unwrap_or_default().to_string(),
                is_formula: c.col_type() == ColumnType::Formula,
                is_relation: c.col_type() == ColumnType::Relation,
            })
    }
}

/// Declared SQLite type for a formula column's result.
fn formula_declared_type(rt: FormulaResultType) -> &'static str {
    match rt {
        FormulaResultType::Number => "REAL",
        FormulaResultType::Text => "TEXT",
        FormulaResultType::Date => "TEXT",
        FormulaResultType::Checkbox => "INTEGER",
    }
}

fn choice_literals(choices: &[OptionMeta]) -> Result<String> {
    choices
        .iter()
        .map(|c| quote_literal(&c.name))
        .collect::<Result<Vec<_>>>()
        .map(|v| v.join(", "))
}

/// Full column definition for `CREATE TABLE` / `ALTER TABLE ADD COLUMN`.
///
/// Returns `Ok(None)` for columns without a physical column (relations — their
/// data lives in the junction table).
pub(crate) fn column_def_sql(col: &ColumnMeta, all: &[ColumnMeta]) -> Result<Option<String>> {
    let Some(sql_name) = col.sql_name() else {
        return Ok(None);
    };
    let q = quote_ident(sql_name);
    let def = match &col.data {
        ColumnData::Text { .. } => format!("{q} TEXT"),
        ColumnData::Number { .. } => format!("{q} REAL"),
        ColumnData::Date { .. } => {
            format!("{q} TEXT CHECK({q} IS NULL OR datetime({q}) IS NOT NULL)")
        }
        ColumnData::Checkbox { .. } => {
            format!("{q} INTEGER NOT NULL DEFAULT 0 CHECK({q} IN (0, 1))")
        }
        ColumnData::Select { choices, .. } => {
            let mut def = format!("{q} TEXT");
            if !choices.is_empty() {
                def.push_str(&format!(" CHECK({q} IN ({}))", choice_literals(choices)?));
            }
            def
        }
        ColumnData::MultiSelect { .. } => {
            format!("{q} TEXT NOT NULL DEFAULT '[]' CHECK(json_valid({q}))")
        }
        ColumnData::Formula(f) => {
            let expr_sql = formula::compile(&f.expr, &formula_resolver(all))?;
            let decl = formula_declared_type(f.result_type);
            // VIRTUAL (not STORED) so the column can be added with
            // ALTER TABLE ADD COLUMN; SQLite still allows indexing it.
            format!("{q} {decl} GENERATED ALWAYS AS ({expr_sql}) VIRTUAL")
        }
        ColumnData::Relation(_) => return Ok(None),
    };
    Ok(Some(def))
}

/// Base (hidden) columns present in every user table.
pub(crate) const BASE_COLUMN_DDL: &str = r#""_rid" TEXT PRIMARY KEY,
  "_created" TEXT NOT NULL,
  "_updated" TEXT NOT NULL"#;

/// Physical column names present in every user table.
pub(crate) const BASE_COLUMNS: [&str; 3] = ["_rid", "_created", "_updated"];

/// `CREATE TABLE` DDL derived entirely from metadata. Formula columns are
/// emitted last (a generated column may only reference plain columns).
pub(crate) fn create_table_ddl(sql_name: &str, cols: &[ColumnMeta]) -> Result<String> {
    let mut defs = vec![BASE_COLUMN_DDL.to_string()];
    let (plain, formulas): (Vec<_>, Vec<_>) = cols
        .iter()
        .filter(|c| c.is_physical())
        .partition(|c| c.col_type() != ColumnType::Formula);
    for c in plain.iter().chain(formulas.iter()) {
        if let Some(def) = column_def_sql(c, cols)? {
            defs.push(def);
        }
    }
    Ok(format_ddl(sql_name, &defs))
}

fn format_ddl(sql_name: &str, defs: &[String]) -> String {
    format!(
        "CREATE TABLE {} (\n  {}\n)",
        quote_ident(sql_name),
        defs.join(",\n  ")
    )
}

/// DDL for a relation column's junction table: real FKs with
/// `ON DELETE CASCADE` on both sides (铁律: no dangling references ever),
/// plus the reverse-lookup index.
pub(crate) fn create_junction_ddl(
    col_id: &str,
    src_table_sql: &str,
    tgt_table_sql: &str,
) -> String {
    let r = quote_ident(&junction_sql_name(col_id));
    let idx = quote_ident(&junction_index_name(col_id));
    let src = quote_ident(src_table_sql);
    let tgt = quote_ident(tgt_table_sql);
    format!(
        r#"CREATE TABLE {r} (
  "a" TEXT NOT NULL REFERENCES {src}("_rid") ON DELETE CASCADE,
  "b" TEXT NOT NULL REFERENCES {tgt}("_rid") ON DELETE CASCADE,
  "ord" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY("a", "b")
) STRICT;
CREATE INDEX {idx} ON {r}("b");"#
    )
}

pub(crate) fn drop_junction_ddl(col_id: &str) -> String {
    format!(
        "DROP TABLE IF EXISTS {}",
        quote_ident(&junction_sql_name(col_id))
    )
}

/// SQL expression converting value expression `x` into the semantics of type
/// `to`. Used when rebuilding a table after a type/options change;
/// unconvertible values become NULL (or the type's empty value).
pub(crate) fn conversion_expr(
    to: ColumnType,
    to_choices: &[OptionMeta],
    x: &str,
) -> Result<String> {
    let expr = match to {
        ColumnType::Text => format!("CAST({x} AS TEXT)"),
        ColumnType::Number => {
            format!("CAST(NULLIF(TRIM(CAST({x} AS TEXT)), '') AS REAL)")
        }
        ColumnType::Checkbox => format!(
            "CASE WHEN typeof({x}) IN ('integer', 'real') THEN ({x} <> 0) \
             WHEN lower(TRIM(CAST({x} AS TEXT))) IN ('true', 'yes', '1') THEN 1 \
             ELSE 0 END"
        ),
        ColumnType::Date => format!(
            "CASE WHEN datetime(CAST({x} AS TEXT)) IS NOT NULL \
             THEN CAST({x} AS TEXT) ELSE NULL END"
        ),
        ColumnType::Select => {
            if to_choices.is_empty() {
                "NULL".to_string()
            } else {
                let lits = choice_literals(to_choices)?;
                format!(
                    "CASE WHEN CAST({x} AS TEXT) IN ({lits}) THEN CAST({x} AS TEXT) ELSE NULL END"
                )
            }
        }
        ColumnType::MultiSelect => {
            format!("CASE WHEN json_valid(CAST({x} AS TEXT)) THEN CAST({x} AS TEXT) ELSE '[]' END")
        }
        // Formula values are recomputed by the generated column; relations
        // have no physical value to convert.
        ColumnType::Formula | ColumnType::Relation => x.to_string(),
    };
    Ok(expr)
}

/// Rebuild a user table in place from metadata, following SQLite's documented
/// 12-step ALTER procedure. MUST run with `foreign_keys = OFF` (see
/// [`crate::db::Workspace::with_tx`]) — otherwise dropping the old table would
/// cascade-delete junction rows.
///
/// `conversions` maps physical column name → SELECT expression used to copy
/// values (e.g. after a type change); columns absent from the map are copied
/// verbatim. Generated (formula) columns are never copied — SQLite recomputes
/// them.
pub(crate) fn rebuild_table(
    conn: &Connection,
    table: &TableMeta,
    cols: &[ColumnMeta],
    conversions: &HashMap<String, String>,
) -> Result<()> {
    let tmp_name = format!("{}_rebuild", table.sql_name);
    let qold = quote_ident(&table.sql_name);
    let qtmp = quote_ident(&tmp_name);

    // A leftover temp table means a previous crash mid-rebuild; safe to drop
    // because the canonical table always survives (the rename is atomic).
    conn.execute_batch(&format!("DROP TABLE IF EXISTS {qtmp};"))?;

    let create = create_table_ddl(&tmp_name, cols)?;
    conn.execute_batch(&create)?;

    // Copy data: base columns + every physical, non-generated column.
    let mut insert_cols: Vec<String> = BASE_COLUMNS.iter().map(|c| quote_ident(c)).collect();
    let mut select_exprs: Vec<String> = BASE_COLUMNS.iter().map(|c| quote_ident(c)).collect();
    for c in cols.iter().filter(|c| c.is_physical()) {
        if c.col_type() == ColumnType::Formula {
            continue; // recomputed by SQLite
        }
        let name = c.sql_name().unwrap_or_default();
        let q = quote_ident(name);
        insert_cols.push(q.clone());
        select_exprs.push(conversions.get(name).cloned().unwrap_or_else(|| q.clone()));
    }
    conn.execute_batch(&format!(
        "INSERT INTO {qtmp} ({}) SELECT {} FROM {qold};",
        insert_cols.join(", "),
        select_exprs.join(", ")
    ))?;

    // Swap: drop FTS (triggers die with the table), drop old, rename new.
    fts::drop(conn, &table.sql_name)?;
    conn.execute_batch(&format!(
        "DROP TABLE {qold};\nALTER TABLE {qtmp} RENAME TO {qold};"
    ))?;

    // Recreate the FTS index and its triggers from (new) metadata.
    fts::rebuild(conn, table, cols)?;
    Ok(())
}

/// `DELETE` statement truncating a junction table to at most one row per `a`
/// (keeps the lowest `ord`), used when a relation flips multi → single.
pub(crate) fn truncate_junction_to_single(col_id: &str) -> String {
    let r = quote_ident(&junction_sql_name(col_id));
    format!(
        "DELETE FROM {r} WHERE rowid NOT IN (\
         SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY \"a\" ORDER BY \"ord\", rowid) AS rn FROM {r}) WHERE rn = 1)"
    )
}

/// Error helper for "column is referenced by formula columns" rejections.
pub(crate) fn formula_dependency_error(col_name: &str, dependents: &[String]) -> AppError {
    AppError::Rejected(format!(
        "列「{col_name}」被公式列引用：{}；请先修改或删除这些公式列",
        dependents.join("、")
    ))
}

/// Collect names of formula columns in `cols` whose compiled expression
/// references `target`'s physical column.
pub(crate) fn formula_dependents(cols: &[ColumnMeta], target: &ColumnMeta) -> Result<Vec<String>> {
    let Some(target_sql) = target.sql_name() else {
        return Ok(Vec::new());
    };
    let needle = quote_ident(target_sql);
    let mut out = Vec::new();
    for c in cols {
        if c.col_type() != ColumnType::Formula || !c.is_physical() {
            continue;
        }
        let Some(f) = c.formula() else { continue };
        // Compile against the current set; a formula that no longer compiles
        // is skipped here (update_column validates it separately).
        if let Ok(sql) = formula::compile(&f.expr, &formula_resolver(cols)) {
            if sql.contains(&needle) {
                out.push(c.name.clone());
            }
        }
    }
    Ok(out)
}
