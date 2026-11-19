//! Shared test helpers. Every test operates on a real encrypted temp file.
#![allow(dead_code)]

use std::path::Path;

use nothing_core::schema::ident::now_iso;
use nothing_core::{
    Choice, ColumnOpts, ColumnType, FormulaOpts, FormulaResultType, NewColumn, RelationOpts,
    SelectOpts, Workspace,
};

pub const PASSWORD: &str = "test-password-🔒";

/// Create a workspace in a fresh temp dir; returns (dir, workspace).
pub fn create_ws(name: &str) -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::create(dir.path().join(name), PASSWORD).unwrap();
    (dir, ws)
}

pub fn db_path(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

/// Independent raw connection to the same file (for inserting rows and
/// asserting physical state). Caller-specified pragmas mirror the kernel's.
pub fn raw(path: &Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.pragma_update(None, "key", PASSWORD).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.pragma_update(None, "busy_timeout", 5000).unwrap();
    conn
}

pub fn col(name: &str, t: ColumnType) -> NewColumn {
    NewColumn {
        name: name.into(),
        col_type: t,
        opts: None,
    }
}

pub fn select_col(name: &str, choices: &[&str]) -> NewColumn {
    NewColumn {
        name: name.into(),
        col_type: ColumnType::Select,
        opts: Some(ColumnOpts::Select(SelectOpts {
            choices: choices
                .iter()
                .map(|c| Choice {
                    id: c.to_string(),
                    name: c.to_string(),
                })
                .collect(),
        })),
    }
}

pub fn multi_select_col(name: &str, choices: &[&str]) -> NewColumn {
    NewColumn {
        name: name.into(),
        col_type: ColumnType::MultiSelect,
        opts: Some(ColumnOpts::MultiSelect(SelectOpts {
            choices: choices
                .iter()
                .map(|c| Choice {
                    id: c.to_string(),
                    name: c.to_string(),
                })
                .collect(),
        })),
    }
}

pub fn relation_col(name: &str, target_table_id: &str, reverse_name: Option<&str>) -> NewColumn {
    NewColumn {
        name: name.into(),
        col_type: ColumnType::Relation,
        opts: Some(ColumnOpts::Relation(RelationOpts {
            target_table_id: target_table_id.into(),
            single: false,
            reverse_name: reverse_name.map(String::from),
        })),
    }
}

pub fn formula_col(name: &str, expr: &str, result_type: FormulaResultType) -> NewColumn {
    NewColumn {
        name: name.into(),
        col_type: ColumnType::Formula,
        opts: Some(ColumnOpts::Formula(FormulaOpts {
            expr: expr.into(),
            result_type,
        })),
    }
}

/// Insert a row through raw SQL, filling the hidden base columns.
pub fn raw_insert_row(conn: &rusqlite::Connection, table_sql: &str, rid: &str) {
    let now = now_iso();
    conn.execute(
        &format!(
            r#"INSERT INTO "{table_sql}" ("_rid", "_created", "_updated") VALUES (?1, ?2, ?2)"#
        ),
        rusqlite::params![rid, now],
    )
    .unwrap();
}

/// Count rows in a physical table.
pub fn raw_count(conn: &rusqlite::Connection, table_sql: &str) -> i64 {
    conn.query_row(&format!(r#"SELECT count(*) FROM "{table_sql}""#), [], |r| {
        r.get(0)
    })
    .unwrap()
}

/// Does a schema object with this exact name exist?
pub fn object_exists(conn: &rusqlite::Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE name = ?1",
        [name],
        |_| Ok(true),
    )
    .optional()
    .unwrap()
    .unwrap_or(false)
}

use rusqlite::OptionalExtension;

/// Standard two-table fixture: 员工(name) and 任务(title, 工时).
pub struct Fixture {
    pub emp_table: nothing_core::TableMeta,
    pub task_table: nothing_core::TableMeta,
    pub emp_cols: Vec<nothing_core::ColumnMeta>,
    pub task_cols: Vec<nothing_core::ColumnMeta>,
}

pub fn emp_task_fixture(ws: &Workspace) -> Fixture {
    let emp_table = ws
        .create_table("员工", vec![col("姓名", ColumnType::Text)])
        .unwrap();
    let task_table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                col("工时", ColumnType::Number),
            ],
        )
        .unwrap();
    let emp_cols = ws.list_columns(&emp_table.id).unwrap();
    let task_cols = ws.list_columns(&task_table.id).unwrap();
    Fixture {
        emp_table,
        task_table,
        emp_cols,
        task_cols,
    }
}
