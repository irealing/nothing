//! Formula columns: SQLite generated columns maintained by the database,
//! whitelist enforcement, expression updates via table rebuild.

mod common;

use common::{raw, raw_insert_row};
use nothing_core::{AppError, ColumnPatch, ColumnType, FormulaResultType};

fn dbp(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

#[test]
fn formula_column_is_maintained_by_database() {
    let (dir, ws) = common::create_ws("fm.nothing");
    let table = ws
        .create_table(
            "订单",
            vec![
                common::col("名称", ColumnType::Text),
                common::col("单价", ColumnType::Number),
                common::col("数量", ColumnType::Number),
                common::formula_col("总价", "[单价] * [数量]", FormulaResultType::Number),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let (c_price, c_qty, c_total) = (
        cols[1].sql_name().unwrap(),
        cols[2].sql_name().unwrap(),
        cols[3].sql_name().unwrap(),
    );

    let conn = raw(&dbp(&dir, "fm.nothing"));
    let sql = &table.sql_name;
    raw_insert_row(&conn, sql, "r1");
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{c_price}" = 9.9, "{c_qty}" = 3 WHERE _rid='r1'"#),
        [],
    )
    .unwrap();
    let total: f64 = conn
        .query_row(
            &format!(r#"SELECT "{c_total}" FROM "{sql}" WHERE _rid='r1'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!((total - 29.7).abs() < 1e-9);

    // DDL really is a generated column
    let ddl: String = conn
        .query_row(
            &format!(r#"SELECT sql FROM sqlite_master WHERE name = '{sql}'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(ddl.contains("GENERATED ALWAYS AS"), "{ddl}");
    assert!(ddl.contains("VIRTUAL"), "{ddl}");

    // formula value updates automatically when inputs change
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{c_qty}" = 10 WHERE _rid='r1'"#),
        [],
    )
    .unwrap();
    let total: f64 = conn
        .query_row(
            &format!(r#"SELECT "{c_total}" FROM "{sql}" WHERE _rid='r1'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!((total - 99.0).abs() < 1e-9);

    // generated columns cannot be written directly
    let err = conn
        .execute(
            &format!(r#"UPDATE "{sql}" SET "{c_total}" = 1 WHERE _rid='r1'"#),
            [],
        )
        .unwrap_err();
    assert!(err.to_string().contains("generated"), "{err}");
}

#[test]
fn formula_whitelist_rejects_injection() {
    let (_dir, ws) = common::create_ws("fw.nothing");
    let table = ws
        .create_table(
            "表",
            vec![
                common::col("名称", ColumnType::Text),
                common::col("数量", ColumnType::Number),
            ],
        )
        .unwrap();
    let bad_exprs = [
        "1; DROP TABLE _tables",
        "(SELECT 1)",
        "sqlite_version()",
        "[名称] || 'x' -- comment", // '-' '-' sequence: `-` then unary minus on `- comment`? → ident error either way
        "",
    ];
    for expr in bad_exprs {
        let err = ws
            .add_column(
                &table.id,
                common::formula_col("坏公式", expr, FormulaResultType::Number),
            )
            .map(|_| ())
            .unwrap_err();
        assert!(
            matches!(err, AppError::InvalidInput(_)),
            "expr {expr:?} → {err:?}"
        );
    }
    // referencing a non-existent column
    let err = ws
        .add_column(
            &table.id,
            common::formula_col("f", "[不存在] + 1", FormulaResultType::Number),
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

#[test]
fn formula_cannot_reference_formula() {
    let (_dir, ws) = common::create_ws("ff.nothing");
    let table = ws
        .create_table(
            "表",
            vec![
                common::col("名称", ColumnType::Text),
                common::col("数量", ColumnType::Number),
                common::formula_col("双倍", "[数量] * 2", FormulaResultType::Number),
            ],
        )
        .unwrap();
    let err = ws
        .add_column(
            &table.id,
            common::formula_col("四倍", "[双倍] * 2", FormulaResultType::Number),
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

#[test]
fn formula_expression_update_recomputes_all_rows() {
    let (dir, ws) = common::create_ws("fu.nothing");
    let table = ws
        .create_table(
            "表",
            vec![
                common::col("名称", ColumnType::Text),
                common::col("数量", ColumnType::Number),
                common::formula_col("双倍", "[数量] * 2", FormulaResultType::Number),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let conn = raw(&dbp(&dir, "fu.nothing"));
    let sql = &table.sql_name;
    raw_insert_row(&conn, sql, "r1");
    conn.execute(
        &format!(
            r#"UPDATE "{sql}" SET "{}" = 5 WHERE _rid='r1'"#,
            cols[1].sql_name().unwrap()
        ),
        [],
    )
    .unwrap();
    drop(conn);

    ws.update_column(
        &table.id,
        &cols[2].id,
        ColumnPatch {
            formula_expr: Some("[数量] * 3".into()),
            formula_result_type: Some(FormulaResultType::Number),
            ..Default::default()
        },
    )
    .unwrap();

    let conn = raw(&dbp(&dir, "fu.nothing"));
    let v: f64 = conn
        .query_row(
            &format!(
                r#"SELECT "{}" FROM "{sql}" WHERE _rid='r1'"#,
                cols[2].sql_name().unwrap()
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v, 15.0);
    // data survived the rebuild
    assert_eq!(common::raw_count(&conn, sql), 1);
}
