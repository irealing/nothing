//! Workspace bootstrap and format-version migrations.
//!
//! 铁律 7: every `format_version` bump must ship an idempotent, transactional
//! step migration here; workspaces upgrade one version at a time.

use rusqlite::{Connection, OptionalExtension};

use crate::db::{APP_VERSION, MAGIC};
use crate::error::{AppError, Result};
use crate::schema::ident::now_iso;

/// Format version understood by this build of nothing-core.
pub const CURRENT_FORMAT_VERSION: u32 = 3;

/// Full DDL for format version 1 (manifest + metadata tables).
///
/// Metadata tables are STRICT (铁律: exact typing) and use `_` prefix.
/// User-facing names never collide with these because physical object names
/// are generated (`t_/c_/r_/v_` + ULID).
const V1_SCHEMA: &str = r#"
CREATE TABLE "_nothing" (
  "key"   TEXT PRIMARY KEY,
  "value" TEXT NOT NULL
) STRICT;

CREATE TABLE "_tables" (
  "id"           TEXT PRIMARY KEY,
  "name"         TEXT NOT NULL UNIQUE,
  "sql_name"     TEXT NOT NULL UNIQUE,
  "title_col_id" TEXT,
  "icon"         TEXT,
  "position"     INTEGER NOT NULL DEFAULT 0,
  "created_at"   TEXT NOT NULL,
  "updated_at"   TEXT NOT NULL
) STRICT;

CREATE TABLE "_columns" (
  "id"         TEXT PRIMARY KEY,
  "table_id"   TEXT NOT NULL REFERENCES "_tables"("id") ON DELETE CASCADE,
  "name"       TEXT NOT NULL,
  "sql_name"   TEXT NOT NULL,
  "type"       TEXT NOT NULL,
  "opts"       TEXT NOT NULL DEFAULT '{}',
  "position"   INTEGER NOT NULL DEFAULT 0,
  "width"      INTEGER NOT NULL DEFAULT 160,
  "visible"    INTEGER NOT NULL DEFAULT 1,
  "is_reverse" INTEGER NOT NULL DEFAULT 0,
  "reverse_of" TEXT,
  "created_at" TEXT NOT NULL,
  UNIQUE("table_id", "name")
) STRICT;

CREATE TABLE "_views" (
  "id"         TEXT PRIMARY KEY,
  "table_id"   TEXT REFERENCES "_tables"("id") ON DELETE CASCADE,
  "name"       TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "config"     TEXT NOT NULL DEFAULT '{}',
  "position"   INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL,
  UNIQUE("table_id", "name")
) STRICT;
"#;

/// Create the v1 metadata schema in a fresh (empty) encrypted database, then
/// run the same step migrations an existing workspace would run. Fresh files
/// and old files therefore travel through one code path.
pub fn bootstrap(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(V1_SCHEMA)?;
    tx.execute(
        r#"INSERT INTO "_nothing"("key", "value") VALUES
             ('magic', ?1),
             ('format_version', ?2),
             ('created_at', ?3),
             ('created_by', ?4)"#,
        rusqlite::params![MAGIC, "1", now_iso(), format!("nothing {APP_VERSION}"),],
    )?;
    tx.commit()?;
    verify_and_migrate(conn)
}

/// v1 → v2: presentation metadata for columns (emoji icon + palette color).
///
/// Idempotent: each column is added only when `PRAGMA table_info` does not
/// already report it, so a half-applied or re-run step is harmless.
fn migrate_v1_to_v2(conn: &Connection) -> Result<()> {
    for (name, decl) in [("icon", "TEXT"), ("color", "TEXT")] {
        if !has_column(conn, "_columns", name)? {
            conn.execute_batch(&format!(
                r#"ALTER TABLE "_columns" ADD COLUMN "{name}" {decl}"#
            ))?;
        }
    }
    Ok(())
}

/// v2 → v3: column alignment and default values.
///
/// Additive only (two nullable TEXT columns), so the step stays idempotent and
/// needs no data backfill.
fn migrate_v2_to_v3(conn: &Connection) -> Result<()> {
    for (name, decl) in [("align", "TEXT"), ("default_value", "TEXT")] {
        if !has_column(conn, "_columns", name)? {
            conn.execute_batch(&format!(
                r#"ALTER TABLE "_columns" ADD COLUMN "{name}" {decl}"#
            ))?;
        }
    }
    Ok(())
}

/// Whether `table` already has `column` (used to keep migrations idempotent).
fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2",
            rusqlite::params![table, column],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    Ok(exists)
}

/// Verify the file is a nothing workspace and migrate it to the current
/// format version if needed.
pub fn verify_and_migrate(conn: &mut Connection) -> Result<()> {
    let magic = manifest_get(conn, "magic")?;
    if magic.as_deref() != Some(MAGIC) {
        return Err(AppError::NotANothingDb);
    }
    let mut version = read_format_version(conn)?;
    if version > CURRENT_FORMAT_VERSION {
        return Err(AppError::FormatTooNew(version));
    }
    // 铁律 7: one transactional, idempotent step per version, applied in
    // order so any old workspace upgrades level by level.
    while version < CURRENT_FORMAT_VERSION {
        let next = version + 1;
        let tx = conn.transaction()?;
        match version {
            1 => migrate_v1_to_v2(&tx)?,
            2 => migrate_v2_to_v3(&tx)?,
            other => {
                return Err(AppError::Internal(format!(
                    "缺少从格式版本 v{other} 升级的迁移脚本"
                )))
            }
        }
        set_format_version(&tx, next)?;
        tx.commit()?;
        version = next;
    }
    Ok(())
}

/// Write `format_version` (only ever called inside a migration transaction).
fn set_format_version(conn: &Connection, version: u32) -> Result<()> {
    conn.execute(
        r#"UPDATE "_nothing" SET "value" = ?1 WHERE "key" = 'format_version'"#,
        [version.to_string()],
    )?;
    Ok(())
}

/// Read `format_version` from the manifest.
pub fn read_format_version(conn: &Connection) -> Result<u32> {
    let raw = manifest_get(conn, "format_version")?.ok_or(AppError::NotANothingDb)?;
    raw.parse::<u32>().map_err(|_| AppError::NotANothingDb)
}

/// Read a manifest key; `Ok(None)` if the manifest table or key is absent.
fn manifest_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    let has_manifest: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_nothing'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !has_manifest {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            r#"SELECT "value" FROM "_nothing" WHERE "key" = ?1"#,
            [key],
            |r| r.get(0),
        )
        .optional()?)
}
