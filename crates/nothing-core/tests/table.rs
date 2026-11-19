//! Table lifecycle: creation DDL, renaming, deletion cleanup, protection
//! against breaking dependent SQL views.

mod common;

use common::{emp_task_fixture, object_exists, raw};
use nothing_core::schema::ident::junction_sql_name;
use nothing_core::{AppError, ColumnType, GridConfig, NewView, SqlConfig, ViewConfig, ViewKind};

#[test]
fn create_table_builds_physical_schema() {
    let (dir, ws) = common::create_ws("t.nothing");
    let f = emp_task_fixture(&ws);

    // Physical table + columns
    let phys = ws.physical_columns(&f.task_table.id).unwrap();
    let names: Vec<&str> = phys.iter().map(|(n, _)| n.as_str()).collect();
    assert!(
        names.starts_with(&["_rid", "_created", "_updated"]),
        "{names:?}"
    );
    assert_eq!(names.len(), 5); // base + 标题 + 工时
    let decls: std::collections::HashMap<_, _> = phys.iter().cloned().collect();
    let title_sql = &f.task_cols[0].sql_name;
    assert_eq!(decls.get(title_sql).unwrap(), "TEXT");
    let hours_sql = &f.task_cols[1].sql_name;
    assert_eq!(decls.get(hours_sql).unwrap(), "REAL");

    // FTS index exists (text column present)
    let conn = raw(&dir.path().join("t.nothing"));
    assert!(object_exists(
        &conn,
        &format!("{}_fts", f.task_table.sql_name)
    ));

    // Metadata: title column = first text column
    assert_eq!(
        f.task_table.title_col_id.as_deref(),
        Some(f.task_cols[0].id.as_str())
    );
    // ULID-based physical names
    assert!(f.task_table.sql_name.starts_with("t_"));
    assert!(title_sql.starts_with("c_"));
}

#[test]
fn duplicate_names_rejected() {
    let (_dir, ws) = common::create_ws("d.nothing");
    ws.create_table("表A", vec![common::col("标题", ColumnType::Text)])
        .unwrap();
    let err = ws
        .create_table("表A", vec![common::col("标题", ColumnType::Text)])
        .unwrap_err();
    assert!(matches!(err, AppError::AlreadyExists(_)), "{err:?}");

    // duplicate column names within one table
    let err = ws
        .create_table(
            "表B",
            vec![
                common::col("标题", ColumnType::Text),
                common::col("标题", ColumnType::Number),
            ],
        )
        .unwrap_err();
    assert!(matches!(err, AppError::AlreadyExists(_)), "{err:?}");
}

#[test]
fn first_column_must_be_text() {
    let (_dir, ws) = common::create_ws("f.nothing");
    let err = ws
        .create_table("表", vec![common::col("n", ColumnType::Number)])
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    let err = ws.create_table("空表", vec![]).unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

#[test]
fn rename_table_is_metadata_only() {
    let (dir, ws) = common::create_ws("r.nothing");
    let f = emp_task_fixture(&ws);
    let conn = raw(&dir.path().join("r.nothing"));
    assert!(object_exists(&conn, &f.emp_table.sql_name));

    let renamed = ws.rename_table(&f.emp_table.id, "成员").unwrap();
    assert_eq!(renamed.name, "成员");
    assert_eq!(renamed.sql_name, f.emp_table.sql_name); // physical unchanged
    assert!(object_exists(&conn, &f.emp_table.sql_name));
}

#[test]
fn delete_table_cleans_everything() {
    let (dir, ws) = common::create_ws("del.nothing");
    let f = emp_task_fixture(&ws);
    // add a relation task→emp with reverse, plus a grid view
    ws.add_column(
        &f.task_table.id,
        common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
    )
    .unwrap();
    ws.create_view(NewView {
        table_id: Some(f.task_table.id.clone()),
        name: "全部任务".into(),
        kind: ViewKind::Grid,
        config: ViewConfig::Grid(GridConfig::default()),
    })
    .unwrap();

    ws.delete_table(&f.task_table.id).unwrap();

    let conn = raw(&dir.path().join("del.nothing"));
    assert!(!object_exists(&conn, &f.task_table.sql_name));
    assert!(!object_exists(
        &conn,
        &format!("{}_fts", f.task_table.sql_name)
    ));
    // metadata for the deleted table is gone
    assert!(ws.list_columns(&f.task_table.id).unwrap().is_empty());
    assert!(ws.get_table(&f.task_table.id).is_err());
    let leftovers = ws.schema_objects("r_%").unwrap();
    assert!(leftovers.is_empty(), "junction leftovers: {leftovers:?}");
    // emp table still has the reverse column removed
    let emp_cols = ws.list_columns(&f.emp_table.id).unwrap();
    assert!(emp_cols.iter().all(|c| !c.is_reverse));
    // grid view gone
    assert!(ws.list_views(Some(&f.task_table.id)).unwrap().is_empty());
}

#[test]
fn delete_table_blocked_by_dependent_sql_view() {
    let (_dir, ws) = common::create_ws("dep.nothing");
    let f = emp_task_fixture(&ws);
    let view = ws
        .create_view(NewView {
            table_id: None,
            name: "任务统计".into(),
            kind: ViewKind::Sql,
            config: ViewConfig::Sql(SqlConfig {
                statement: format!("SELECT count(*) AS n FROM {}", f.task_table.sql_name),
            }),
        })
        .unwrap();
    let err = ws.delete_table(&f.task_table.id).unwrap_err();
    match &err {
        AppError::Rejected(msg) => assert!(msg.contains("任务统计"), "{msg}"),
        other => panic!("unexpected: {other:?}"),
    }
    ws.delete_view(&view.id).unwrap();
    ws.delete_table(&f.task_table.id).unwrap();
}

#[test]
fn delete_relation_column_drops_junction_and_reverse() {
    let (dir, ws) = common::create_ws("rdel.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();
    let conn = raw(&dir.path().join("rdel.nothing"));
    let jname = junction_sql_name(&rel.id);
    assert!(object_exists(&conn, &jname));

    ws.delete_column(&f.task_table.id, &rel.id).unwrap();
    assert!(!object_exists(&conn, &jname));
    let emp_cols = ws.list_columns(&f.emp_table.id).unwrap();
    assert!(emp_cols.iter().all(|c| !c.is_reverse));
}
