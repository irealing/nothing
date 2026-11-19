//! FTS5 full-text index for user tables.
//!
//! Each user table gets an external-content FTS5 index (`t_<id>_fts`) over its
//! searchable columns (text & select), kept in sync by triggers. The index and
//! its triggers are rebuilt from metadata whenever the searchable column set
//! changes (add/drop/type-change) — metadata is the source of truth.
//!
//! Tokenizer: `trigram`, which supports substring matching and works for CJK
//! text (unicode61 would treat a whole Chinese run as one token). Queries
//! shorter than 3 chars fall back to LIKE in the query layer (M2).

use rusqlite::Connection;

use super::ident::{quote_ident, quote_literal};
use super::{ColumnMeta, TableMeta};
use crate::error::Result;

pub(crate) fn fts_table_name(table_sql_name: &str) -> String {
    format!("{table_sql_name}_fts")
}

/// Sync-trigger names for a table (quoted as whole identifiers).
fn trigger_names(table_sql_name: &str) -> [String; 3] {
    [
        quote_ident(&format!("{table_sql_name}_fts_ai")),
        quote_ident(&format!("{table_sql_name}_fts_ad")),
        quote_ident(&format!("{table_sql_name}_fts_au")),
    ]
}

/// Drop the FTS index and its sync triggers for a table (if present).
pub(crate) fn drop(conn: &Connection, table_sql_name: &str) -> Result<()> {
    let qfts = quote_ident(&fts_table_name(table_sql_name));
    let [ai, ad, au] = trigger_names(table_sql_name);
    conn.execute_batch(&format!(
        r#"
        DROP TRIGGER IF EXISTS {ai};
        DROP TRIGGER IF EXISTS {ad};
        DROP TRIGGER IF EXISTS {au};
        DROP TABLE IF EXISTS {qfts};
        "#
    ))?;
    Ok(())
}

/// (Re)create the FTS index + sync triggers from the given column set and
/// populate it from the content table.
///
/// Must be called inside the same transaction as the DDL that changed the
/// searchable column set, and while the user table physically exists.
pub(crate) fn rebuild(conn: &Connection, table: &TableMeta, cols: &[ColumnMeta]) -> Result<()> {
    drop(conn, &table.sql_name)?;

    let searchable: Vec<&ColumnMeta> = cols
        .iter()
        .filter(|c| c.is_physical() && c.col_type.is_searchable())
        .collect();
    if searchable.is_empty() {
        return Ok(());
    }

    let qtab = quote_ident(&table.sql_name);
    let qfts = quote_ident(&fts_table_name(&table.sql_name));
    let [ai, ad, au] = trigger_names(&table.sql_name);
    let content = quote_literal(&table.sql_name)?;
    let col_list: Vec<String> = searchable
        .iter()
        .map(|c| quote_ident(&c.sql_name))
        .collect();
    let cols_sql = col_list.join(", ");
    let new_vals: Vec<String> = searchable
        .iter()
        .map(|c| format!("new.{}", quote_ident(&c.sql_name)))
        .collect();
    let new_vals = new_vals.join(", ");
    let old_vals: Vec<String> = searchable
        .iter()
        .map(|c| format!("old.{}", quote_ident(&c.sql_name)))
        .collect();
    let old_vals = old_vals.join(", ");

    conn.execute_batch(&format!(
        r#"
        CREATE VIRTUAL TABLE {qfts} USING fts5(
            {cols_sql},
            content={content},
            content_rowid='rowid',
            tokenize='trigram'
        );

        CREATE TRIGGER {ai} AFTER INSERT ON {qtab} BEGIN
            INSERT INTO {qfts}(rowid, {cols_sql}) VALUES (new.rowid, {new_vals});
        END;

        CREATE TRIGGER {ad} AFTER DELETE ON {qtab} BEGIN
            INSERT INTO {qfts}({qfts}, rowid, {cols_sql}) VALUES ('delete', old.rowid, {old_vals});
        END;

        CREATE TRIGGER {au} AFTER UPDATE ON {qtab} BEGIN
            INSERT INTO {qfts}({qfts}, rowid, {cols_sql}) VALUES ('delete', old.rowid, {old_vals});
            INSERT INTO {qfts}(rowid, {cols_sql}) VALUES (new.rowid, {new_vals});
        END;

        INSERT INTO {qfts}({qfts}) VALUES ('rebuild');
        "#
    ))?;
    Ok(())
}
