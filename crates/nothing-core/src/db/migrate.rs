//! Workspace bootstrap and format-version migrations.
//!
//! 铁律 7: every `format_version` bump must ship an idempotent, transactional
//! step migration here; workspaces upgrade one version at a time.

use rusqlite::{Connection, OptionalExtension};

use crate::db::{APP_VERSION, MAGIC};
use crate::error::{AppError, Result};
use crate::schema::ident::now_iso;

/// Format version understood by this build of nothing-core.
pub const CURRENT_FORMAT_VERSION: u32 = 1;

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

/// Create the full v1 metadata schema in a fresh (empty) encrypted database.
pub fn bootstrap(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(V1_SCHEMA)?;
    tx.execute(
        r#"INSERT INTO "_nothing"("key", "value") VALUES
             ('magic', ?1),
             ('format_version', ?2),
             ('created_at', ?3),
             ('created_by', ?4)"#,
        rusqlite::params![
            MAGIC,
            CURRENT_FORMAT_VERSION.to_string(),
            now_iso(),
            format!("nothing {APP_VERSION}"),
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// Verify the file is a nothing workspace and migrate it to the current
/// format version if needed.
pub fn verify_and_migrate(conn: &mut Connection) -> Result<()> {
    let magic = manifest_get(conn, "magic")?;
    if magic.as_deref() != Some(MAGIC) {
        return Err(AppError::NotANothingDb);
    }
    let version = read_format_version(conn)?;
    if version > CURRENT_FORMAT_VERSION {
        return Err(AppError::FormatTooNew(version));
    }
    if version < CURRENT_FORMAT_VERSION {
        // Step migrations land here as the format evolves (铁律 7): each step
        // runs in its own transaction, is idempotent, and bumps
        // format_version by one, e.g.:
        //
        //   let tx = conn.transaction()?;
        //   migrate_1_to_2(&tx)?;
        //   tx.execute(r#"UPDATE "_nothing" SET "value" = '2' WHERE "key" = 'format_version'"#, [])?;
        //   tx.commit()?;
        return Err(AppError::Internal(format!(
            "缺少从格式版本 v{version} 升级的迁移脚本"
        )));
    }
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
