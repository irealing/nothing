//! Workspace bootstrap and format-version checks.
//!
//! Format v4 replaced the three typed metadata tables (`_tables`, `_columns`,
//! `_views`) with a **single** self-referencing `_meta` node table. The Rust
//! object model (see [`crate::schema`]) is the source of truth for invariants;
//! SQL only stores typed fields and provides a safety net (CHECK + FK).
//!
//! 铁律 7 is intentionally relaxed for this pre-release reset: older workspace
//! files are rejected with a clear "format too old" error instead of being
//! migrated, because the app has no released users yet.

use rusqlite::Connection;

use crate::db::{APP_VERSION, MAGIC};
use crate::error::{AppError, Result};
use crate::schema::ident::now_iso;

/// Format version understood by this build of nothing-core.
pub const CURRENT_FORMAT_VERSION: u32 = 4;

/// Full DDL for the current format: manifest + one polymorphic metadata node
/// table + the indexes that encode per-kind uniqueness and tree ordering.
const V4_SCHEMA: &str = r#"
CREATE TABLE "_nothing" (
  "key"   TEXT PRIMARY KEY,
  "value" TEXT NOT NULL
) STRICT;

-- One node table for every metadata object:
--   table / column / option / view / view_column
-- `parent_id` is the containment edge (and lifetime owner); the other id
-- columns are cross references (title column, relation target, reverse origin,
-- base column projected by a view column).
CREATE TABLE "_meta" (
  "id"         TEXT PRIMARY KEY,
  "parent_id"  TEXT REFERENCES "_meta"("id") ON DELETE CASCADE,
  "kind"       TEXT NOT NULL CHECK ("kind" IN
                 ('table','column','option','view','view_column')),
  "name"       TEXT,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "icon"       TEXT,
  "color"      TEXT,
  "width"      INTEGER,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,

  -- table / column physical name
  "sql_name"     TEXT,
  "title_col_id" TEXT REFERENCES "_meta"("id") ON DELETE SET NULL,

  -- column
  "col_type" TEXT CHECK ("col_type" IS NULL OR "col_type" IN
                ('text','number','select','multi_select','date',
                 'checkbox','relation','formula')),
  "align"         TEXT CHECK ("align" IS NULL OR "align" IN ('left','center','right')),
  "default_value" TEXT,

  -- relation column
  "target_table_id" TEXT REFERENCES "_meta"("id") ON DELETE CASCADE,
  "single"          INTEGER CHECK ("single" IS NULL OR "single" IN (0,1)),
  "origin_id"       TEXT REFERENCES "_meta"("id") ON DELETE CASCADE,

  -- formula column
  "formula_expr"        TEXT,
  "formula_result_type" TEXT CHECK ("formula_result_type" IS NULL OR
                                    "formula_result_type" IN ('number','text','date','checkbox')),

  -- view
  "view_kind" TEXT CHECK ("view_kind" IS NULL OR "view_kind" IN ('grid','sql')),
  "filters"   TEXT,
  "sorts"     TEXT,
  "statement" TEXT,

  -- view_column
  "ref_id" TEXT REFERENCES "_meta"("id") ON DELETE CASCADE,
  "hidden" INTEGER CHECK ("hidden" IS NULL OR "hidden" IN (0,1)),

  CHECK (
    -- table
    ("kind"='table'
       AND "parent_id" IS NULL AND "name" IS NOT NULL
       AND "sql_name" IS NOT NULL AND "col_type" IS NULL
       AND "view_kind" IS NULL AND "ref_id" IS NULL
       AND "width" IS NULL AND "hidden" IS NULL)
    OR
    -- column
    ("kind"='column'
       AND "parent_id" IS NOT NULL AND "name" IS NOT NULL
       AND "col_type" IS NOT NULL AND "width" IS NOT NULL
       AND "view_kind" IS NULL AND "ref_id" IS NULL AND "hidden" IS NULL
       AND CASE "col_type"
             WHEN 'relation' THEN
               "sql_name" IS NULL AND "target_table_id" IS NOT NULL
               AND "single" IS NOT NULL AND "formula_expr" IS NULL
               AND "formula_result_type" IS NULL
             WHEN 'formula' THEN
               "sql_name" IS NOT NULL AND "formula_expr" IS NOT NULL
               AND "formula_result_type" IS NOT NULL
               AND "target_table_id" IS NULL AND "single" IS NULL
             ELSE
               "sql_name" IS NOT NULL AND "target_table_id" IS NULL
               AND "single" IS NULL AND "origin_id" IS NULL
               AND "formula_expr" IS NULL AND "formula_result_type" IS NULL
           END)
    OR
    -- select choice
    ("kind"='option'
       AND "parent_id" IS NOT NULL AND "name" IS NOT NULL
       AND "col_type" IS NULL AND "sql_name" IS NULL
       AND "view_kind" IS NULL AND "ref_id" IS NULL
       AND "width" IS NULL AND "hidden" IS NULL)
    OR
    -- view
    ("kind"='view'
       AND "name" IS NOT NULL AND "view_kind" IS NOT NULL
       AND "col_type" IS NULL AND "sql_name" IS NULL
       AND "ref_id" IS NULL AND "width" IS NULL AND "hidden" IS NULL
       AND ("view_kind" <> 'grid' OR "statement" IS NULL)
       AND ("view_kind" <> 'sql' OR ("filters" IS NULL AND "sorts" IS NULL)))
    OR
    -- view column (a view's own column node, projecting a base column)
    ("kind"='view_column'
       AND "parent_id" IS NOT NULL AND "name" IS NULL
       AND "ref_id" IS NOT NULL AND "width" IS NOT NULL AND "hidden" IS NOT NULL
       AND "col_type" IS NULL AND "view_kind" IS NULL AND "sql_name" IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX "u_meta_table_name"  ON "_meta"("name") WHERE "kind" = 'table';
CREATE UNIQUE INDEX "u_meta_column_name" ON "_meta"("parent_id","name") WHERE "kind" = 'column';
CREATE UNIQUE INDEX "u_meta_option_name" ON "_meta"("parent_id","name") WHERE "kind" = 'option';
CREATE UNIQUE INDEX "u_meta_view_name"   ON "_meta"(COALESCE("parent_id",''),"name") WHERE "kind" = 'view';
CREATE UNIQUE INDEX "u_meta_view_col"    ON "_meta"("parent_id","ref_id") WHERE "kind" = 'view_column';
CREATE UNIQUE INDEX "u_meta_sql_name"    ON "_meta"("sql_name") WHERE "sql_name" IS NOT NULL;
CREATE INDEX "i_meta_children" ON "_meta"("parent_id","kind","position");
CREATE INDEX "i_meta_kind"     ON "_meta"("kind","position");
"#;

/// Create the current metadata schema in a fresh (empty) encrypted database.
pub fn bootstrap(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(V4_SCHEMA)?;
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

/// Verify the file is a nothing workspace and that its format is supported.
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
        // Pre-release hard cut: v1–v3 used three separate metadata tables and
        // are not migrated. Refuse loudly instead of half-reading them.
        return Err(AppError::FormatTooOld(version));
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
    use rusqlite::OptionalExtension;
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
