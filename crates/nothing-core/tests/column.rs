//! Column DDL, constraints, renames (铁律 3), type-change migrations (铁律 2)
//! and the FTS5 index lifecycle.

mod common;

use common::{emp_task_fixture, object_exists, raw, raw_insert_row};
use nothing_core::{AppError, ColumnPatch, ColumnType, FormulaResultType, NewChoice};

/// Path helper for the workspace file in each test.
fn dbp(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

#[test]
fn check_constraints_enforced_by_database() {
    let (dir, ws) = common::create_ws("c.nothing");
    let table = ws
        .create_table(
            "约束表",
            vec![
                common::col("标题", ColumnType::Text),
                common::select_col("状态", &["待办", "进行中"]),
                common::multi_select_col("标签", &["a", "b"]),
                common::col("截止", ColumnType::Date),
                common::col("完成", ColumnType::Checkbox),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let sql = &table.sql_name;
    let conn = raw(&dbp(&dir, "c.nothing"));
    raw_insert_row(&conn, sql, "row1");
    let (c_status, c_tags, c_date, c_done) = (
        cols[1].sql_name().unwrap(),
        cols[2].sql_name().unwrap(),
        cols[3].sql_name().unwrap(),
        cols[4].sql_name().unwrap(),
    );

    // select: invalid choice rejected by CHECK
    let err = conn
        .execute(
            &format!(r#"UPDATE "{sql}" SET "{c_status}" = '不存在的状态' WHERE _rid='row1'"#),
            [],
        )
        .unwrap_err();
    assert!(err.to_string().contains("CHECK"), "{err}");
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{c_status}" = '待办' WHERE _rid='row1'"#),
        [],
    )
    .unwrap();

    // multi_select: must be valid JSON
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{c_tags}" = 'not-json' WHERE _rid='row1'"#),
        [],
    )
    .unwrap_err();
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{c_tags}" = '["a","b"]' WHERE _rid='row1'"#),
        [],
    )
    .unwrap();

    // date: invalid date rejected
    let err = conn
        .execute(
            &format!(r#"UPDATE "{sql}" SET "{c_date}" = '31月' WHERE _rid='row1'"#),
            [],
        )
        .unwrap_err();
    assert!(err.to_string().contains("CHECK"), "{err}");
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{c_date}" = '2026-12-01T10:00:00Z' WHERE _rid='row1'"#),
        [],
    )
    .unwrap();

    // checkbox: only 0/1
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{c_done}" = 5 WHERE _rid='row1'"#),
        [],
    )
    .unwrap_err();
    // default is 0
    let v: i64 = conn
        .query_row(
            &format!(r#"SELECT "{c_done}" FROM "{sql}" WHERE _rid='row1'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v, 0);
}

#[test]
fn ui_rename_never_touches_physical_column() {
    let (dir, ws) = common::create_ws("rn.nothing");
    let f = emp_task_fixture(&ws);
    let before = ws.physical_columns(&f.task_table.id).unwrap();
    let renamed = ws
        .update_column(
            &f.task_table.id,
            &f.task_cols[1].id,
            ColumnPatch {
                name: Some("预计小时".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(renamed.name, "预计小时");
    assert_eq!(renamed.sql_name(), f.task_cols[1].sql_name()); // 铁律 3
    let after = ws.physical_columns(&f.task_table.id).unwrap();
    assert_eq!(before, after);

    // duplicate name rejected
    let err = ws
        .update_column(
            &f.task_table.id,
            &f.task_cols[1].id,
            ColumnPatch {
                name: Some("标题".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::AlreadyExists(_)), "{err:?}");
    let _ = (&dir, &f);
}

#[test]
fn type_change_converts_values_in_one_transaction() {
    let (dir, ws) = common::create_ws("tc.nothing");
    let table = ws
        .create_table(
            "转换表",
            vec![
                common::col("标题", ColumnType::Text),
                common::col("值", ColumnType::Text),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let val_sql = cols[1].sql_name().unwrap().to_string();
    let conn = raw(&dbp(&dir, "tc.nothing"));
    let sql = table.sql_name.clone();
    raw_insert_row(&conn, &sql, "r1");
    raw_insert_row(&conn, &sql, "r2");
    raw_insert_row(&conn, &sql, "r3");
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{val_sql}" = '42.5' WHERE _rid='r1'"#),
        [],
    )
    .unwrap();
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{val_sql}" = '7' WHERE _rid='r2'"#),
        [],
    )
    .unwrap();
    // r3 stays NULL

    // text → number
    let updated = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                col_type: Some(ColumnType::Number),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.col_type(), ColumnType::Number);
    assert_eq!(updated.sql_name().unwrap(), val_sql); // physical name preserved

    let v1: f64 = conn
        .query_row(
            &format!(r#"SELECT "{val_sql}" FROM "{sql}" WHERE _rid='r1'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v1, 42.5);
    let v2: f64 = conn
        .query_row(
            &format!(r#"SELECT "{val_sql}" FROM "{sql}" WHERE _rid='r2'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v2, 7.0);
    let v3: Option<f64> = conn
        .query_row(
            &format!(r#"SELECT "{val_sql}" FROM "{sql}" WHERE _rid='r3'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(v3.is_none());

    // table kept its identity: fts rebuilt, no leftover rebuild table
    assert!(object_exists(&conn, &format!("{sql}_fts")));
    assert!(!object_exists(&conn, &format!("{sql}_rebuild")));
    drop(conn);

    // number → text round trip
    let _ = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                col_type: Some(ColumnType::Text),
                ..Default::default()
            },
        )
        .unwrap();
    let conn = raw(&dbp(&dir, "tc.nothing"));
    let s: String = conn
        .query_row(
            &format!(r#"SELECT "{val_sql}" FROM "{sql}" WHERE _rid='r1'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(s, "42.5");
}

#[test]
fn select_choices_change_nullifies_invalid_values() {
    let (dir, ws) = common::create_ws("ch.nothing");
    let table = ws
        .create_table(
            "状态表",
            vec![
                common::col("标题", ColumnType::Text),
                common::select_col("状态", &["待办", "进行中", "完成"]),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let conn = raw(&dbp(&dir, "ch.nothing"));
    raw_insert_row(&conn, &table.sql_name, "r1");
    raw_insert_row(&conn, &table.sql_name, "r2");
    conn.execute(
        &format!(
            r#"UPDATE "{}" SET "{}" = '完成' WHERE _rid='r1'"#,
            table.sql_name,
            cols[1].sql_name().unwrap()
        ),
        [],
    )
    .unwrap();
    conn.execute(
        &format!(
            r#"UPDATE "{}" SET "{}" = '待办' WHERE _rid='r2'"#,
            table.sql_name,
            cols[1].sql_name().unwrap()
        ),
        [],
    )
    .unwrap();
    drop(conn);

    // remove "完成" from choices
    let new_choices = vec![
        NewChoice {
            id: Some("1".into()),
            name: "待办".into(),
            icon: None,
            color: None,
        },
        NewChoice {
            id: Some("2".into()),
            name: "进行中".into(),
            icon: None,
            color: None,
        },
    ];
    ws.update_column(
        &table.id,
        &cols[1].id,
        ColumnPatch {
            choices: Some(new_choices),
            ..Default::default()
        },
    )
    .unwrap();

    let conn = raw(&dbp(&dir, "ch.nothing"));
    let v1: Option<String> = conn
        .query_row(
            &format!(
                r#"SELECT "{}" FROM "{}" WHERE _rid='r1'"#,
                cols[1].sql_name().unwrap(),
                table.sql_name
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(v1.is_none(), "removed choice must become NULL");
    let v2: Option<String> = conn
        .query_row(
            &format!(
                r#"SELECT "{}" FROM "{}" WHERE _rid='r2'"#,
                cols[1].sql_name().unwrap(),
                table.sql_name
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v2.as_deref(), Some("待办"));
    // old choice now rejected by the new CHECK
    let err = conn
        .execute(
            &format!(
                r#"UPDATE "{}" SET "{}" = '完成' WHERE _rid='r1'"#,
                table.sql_name,
                cols[1].sql_name().unwrap()
            ),
            [],
        )
        .unwrap_err();
    assert!(err.to_string().contains("CHECK"), "{err}");
}

#[test]
fn title_column_is_protected() {
    let (_dir, ws) = common::create_ws("tp.nothing");
    let f = emp_task_fixture(&ws);
    let title_id = f.task_table.title_col_id.clone().unwrap();
    let err = ws
        .update_column(
            &f.task_table.id,
            &title_id,
            ColumnPatch {
                col_type: Some(ColumnType::Number),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::Rejected(_)), "{err:?}");
    let err = ws.delete_column(&f.task_table.id, &title_id).unwrap_err();
    assert!(matches!(err, AppError::Rejected(_)), "{err:?}");

    // after switching title to another text column, deletion allowed
    let extra = ws
        .add_column(&f.task_table.id, common::col("别名", ColumnType::Text))
        .unwrap();
    ws.set_title_column(&f.task_table.id, &extra.id).unwrap();
    ws.delete_column(&f.task_table.id, &title_id).unwrap();
}

#[test]
fn fts_index_tracks_searchable_columns() {
    let (dir, ws) = common::create_ws("fts.nothing");
    let table = ws
        .create_table("文章", vec![common::col("标题", ColumnType::Text)])
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let conn = raw(&dbp(&dir, "fts.nothing"));
    let sql = &table.sql_name;
    let title = cols[0].sql_name().unwrap();
    raw_insert_row(&conn, sql, "r1");
    conn.execute(
        &format!(r#"UPDATE "{sql}" SET "{title}" = '数据库系统概念' WHERE _rid='r1'"#),
        [],
    )
    .unwrap();

    // CJK substring search via trigram tokenizer (>= 3 chars; shorter
    // queries fall back to LIKE in the query layer)
    let hits: i64 = conn
        .query_row(
            &format!(r#"SELECT count(*) FROM "{sql}_fts" WHERE "{sql}_fts" MATCH '数据库'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hits, 1);

    // add another text column → it joins the index
    let body = ws
        .add_column(&table.id, common::col("正文", ColumnType::Text))
        .unwrap();
    conn.execute(
        &format!(
            r#"UPDATE "{sql}" SET "{}" = '事务与恢复' WHERE _rid='r1'"#,
            body.sql_name().unwrap()
        ),
        [],
    )
    .unwrap();
    let hits: i64 = conn
        .query_row(
            &format!(r#"SELECT count(*) FROM "{sql}_fts" WHERE "{sql}_fts" MATCH '事务与恢复'"#),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hits, 1);

    // delete the searchable column → index rebuilt without it
    ws.delete_column(&table.id, &body.id).unwrap();
    let cols: Vec<String> = conn
        .prepare(&format!(
            r#"SELECT sql FROM sqlite_master WHERE name = '{sql}_fts'"#
        ))
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(!cols[0].contains(body.sql_name().unwrap()), "{}", cols[0]);
}

#[test]
fn delete_column_blocked_by_formula_dependency() {
    let (_dir, ws) = common::create_ws("fd.nothing");
    let table = ws
        .create_table(
            "订单",
            vec![
                common::col("名称", ColumnType::Text),
                common::col("单价", ColumnType::Number),
                common::col("数量", ColumnType::Number),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let total = ws
        .add_column(
            &table.id,
            common::formula_col("总价", "[单价] * [数量]", FormulaResultType::Number),
        )
        .unwrap();

    let err = ws.delete_column(&table.id, &cols[1].id).unwrap_err();
    match &err {
        AppError::Rejected(msg) => assert!(msg.contains("总价"), "{msg}"),
        other => panic!("unexpected {other:?}"),
    }
    // type change is blocked too
    let err = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                col_type: Some(ColumnType::Text),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::Rejected(_)), "{err:?}");

    // after deleting the formula, the column can go
    ws.delete_column(&table.id, &total.id).unwrap();
    ws.delete_column(&table.id, &cols[1].id).unwrap();
}

#[test]
fn reorder_positions() {
    let (_dir, ws) = common::create_ws("ro.nothing");
    let f = emp_task_fixture(&ws);
    let extra = ws
        .add_column(&f.task_table.id, common::col("备注", ColumnType::Text))
        .unwrap();
    // move 备注 (last, position 2) to the front
    ws.update_column(
        &f.task_table.id,
        &extra.id,
        ColumnPatch {
            position: Some(0),
            ..Default::default()
        },
    )
    .unwrap();
    let cols = ws.list_columns(&f.task_table.id).unwrap();
    assert_eq!(cols[0].id, extra.id);
    let positions: Vec<i64> = cols.iter().map(|c| c.position).collect();
    assert_eq!(positions, vec![0, 1, 2]);
}
