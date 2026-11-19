//! Views: grid view metadata CRUD + validation; SQL views stored as real
//! `CREATE VIEW` objects with whitelist validation (铁律 4).

mod common;

use common::{emp_task_fixture, object_exists, raw, raw_insert_row};
use nothing_core::{
    AppError, FilterNode, FilterOp, FilterRule, GridConfig, LogicOp, NewView, SortSpec, SqlConfig,
    ViewConfig, ViewKind, ViewPatch,
};

fn dbp(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

fn grid_view(name: &str, table_id: Option<String>, cfg: GridConfig) -> NewView {
    NewView {
        table_id,
        name: name.into(),
        kind: ViewKind::Grid,
        config: ViewConfig::Grid(cfg),
    }
}

fn sql_view(name: &str, statement: String) -> NewView {
    NewView {
        table_id: None,
        name: name.into(),
        kind: ViewKind::Sql,
        config: ViewConfig::Sql(SqlConfig { statement }),
    }
}

#[test]
fn grid_view_crud_and_validation() {
    let (_dir, ws) = common::create_ws("gv.nothing");
    let f = emp_task_fixture(&ws);
    let title_col = f.task_table.title_col_id.clone().unwrap();
    let hours_col = f.task_cols[1].id.clone();

    let view = ws
        .create_view(grid_view(
            "进行中",
            Some(f.task_table.id.clone()),
            GridConfig {
                filters: Some(FilterNode::Group {
                    op: LogicOp::And,
                    children: vec![FilterNode::Rule(FilterRule {
                        column_id: hours_col.clone(),
                        op: FilterOp::Gt,
                        value: serde_json::json!(0),
                    })],
                }),
                sorts: vec![SortSpec {
                    column_id: title_col.clone(),
                    desc: false,
                }],
                hidden_columns: vec![hours_col.clone()],
            },
        ))
        .unwrap();
    assert_eq!(view.kind, ViewKind::Grid);
    assert_eq!(view.table_id.as_deref(), Some(f.task_table.id.as_str()));

    // duplicate name in same scope
    let err = ws
        .create_view(grid_view(
            "进行中",
            Some(f.task_table.id.clone()),
            GridConfig::default(),
        ))
        .unwrap_err();
    assert!(matches!(err, AppError::AlreadyExists(_)), "{err:?}");

    // filter/sort referencing a non-existent column
    let err = ws
        .create_view(grid_view(
            "坏引用",
            Some(f.task_table.id.clone()),
            GridConfig {
                sorts: vec![SortSpec {
                    column_id: "GHOST".into(),
                    desc: false,
                }],
                ..Default::default()
            },
        ))
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");

    // grid view requires table; sql view forbids table
    let err = ws
        .create_view(grid_view("无主", None, GridConfig::default()))
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");

    // list returns the table's grid views (+ globals)
    let views = ws.list_views(Some(&f.task_table.id)).unwrap();
    assert_eq!(views.len(), 1);

    // update name + config
    let updated = ws
        .update_view(
            &view.id,
            ViewPatch {
                name: Some("高工时".into()),
                config: Some(ViewConfig::Grid(GridConfig {
                    filters: None,
                    sorts: vec![SortSpec {
                        column_id: hours_col,
                        desc: true,
                    }],
                    hidden_columns: vec![],
                })),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.name, "高工时");

    ws.delete_view(&view.id).unwrap();
    assert!(matches!(
        ws.get_view(&view.id).unwrap_err(),
        AppError::NotFound(_)
    ));
    let _ = title_col;
}

#[test]
fn sql_view_creates_real_view_object() {
    let (dir, ws) = common::create_ws("sv.nothing");
    let f = emp_task_fixture(&ws);
    let conn = raw(&dbp(&dir, "sv.nothing"));
    raw_insert_row(&conn, &f.task_table.sql_name, "t1");
    raw_insert_row(&conn, &f.task_table.sql_name, "t2");
    drop(conn);

    let statement = format!(
        "SELECT _rid, {} AS title FROM {} ORDER BY _rid",
        f.task_cols[0].sql_name, f.task_table.sql_name
    );
    let view = ws.create_view(sql_view("全部任务", statement)).unwrap();

    let vobj = nothing_core::schema::ident::view_sql_name(&view.id);
    let conn = raw(&dbp(&dir, "sv.nothing"));
    assert!(object_exists(&conn, &vobj));
    let ids: Vec<String> = conn
        .prepare(&format!(r#"SELECT _rid FROM "{vobj}""#))
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);

    // multi-table SQL view (the killer feature vs grid views)
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, None),
        )
        .unwrap();
    let junction = nothing_core::schema::ident::junction_sql_name(&rel.id);
    let join_view = ws
        .create_view(sql_view(
            "任务与员工",
            format!(
                "SELECT t._rid AS task, j.b AS emp FROM {} t JOIN {junction} j ON j.a = t._rid",
                f.task_table.sql_name
            ),
        ))
        .unwrap();
    assert!(object_exists(
        &conn,
        &nothing_core::schema::ident::view_sql_name(&join_view.id)
    ));

    // delete drops the physical view
    ws.delete_view(&view.id).unwrap();
    assert!(!object_exists(&conn, &vobj));
}

#[test]
fn sql_view_validation_rejects_non_select() {
    let (_dir, ws) = common::create_ws("svv.nothing");
    let f = emp_task_fixture(&ws);
    let bad = [
        format!("DELETE FROM {}", f.task_table.sql_name),
        format!("UPDATE {} SET _rid = 'x'", f.task_table.sql_name),
        format!("DROP TABLE {}", f.task_table.sql_name),
        "INSERT INTO _tables VALUES (1,2,3,4,5,6,7,8)".to_string(),
        format!("SELECT 1; DROP TABLE {}", f.task_table.sql_name),
        "PRAGMA key = 'hack'".to_string(),
        "/* SELECT */ DROP TABLE _tables".to_string(),
        "-- x\nSELECT 1".to_string(),
        format!("SELECT * FROM does_not_exist_{}", "x"),
        "".to_string(),
    ];
    for stmt in bad {
        let err = ws.create_view(sql_view("坏视图", stmt.clone())).map(|_| ());
        assert!(
            matches!(err, Err(AppError::InvalidInput(_))),
            "stmt {stmt:?} → {err:?}"
        );
    }
    // no view object leaked into the schema
    assert!(ws.schema_objects("v_%").unwrap().is_empty());
}

#[test]
fn sql_view_with_cte_and_trailing_semicolon_ok() {
    let (_dir, ws) = common::create_ws("cte.nothing");
    let f = emp_task_fixture(&ws);
    let v = ws
        .create_view(sql_view(
            "CTE 视图",
            format!(
                "WITH t AS (SELECT _rid FROM {}) SELECT count(*) AS n FROM t;",
                f.task_table.sql_name
            ),
        ))
        .unwrap();
    assert_eq!(v.kind, ViewKind::Sql);
}

#[test]
fn sql_view_update_recreates_object() {
    let (dir, ws) = common::create_ws("svu.nothing");
    let f = emp_task_fixture(&ws);
    let view = ws
        .create_view(sql_view(
            "计数",
            format!("SELECT count(*) AS n FROM {}", f.task_table.sql_name),
        ))
        .unwrap();
    let conn = raw(&dbp(&dir, "svu.nothing"));
    raw_insert_row(&conn, &f.task_table.sql_name, "t1");
    let n: i64 = conn
        .query_row(
            &format!(
                "SELECT n FROM {}",
                nothing_core::schema::ident::view_sql_name(&view.id)
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
    drop(conn);

    ws.update_view(
        &view.id,
        ViewPatch {
            config: Some(ViewConfig::Sql(SqlConfig {
                statement: format!("SELECT count(*) * 10 AS n FROM {}", f.task_table.sql_name),
            })),
            ..Default::default()
        },
    )
    .unwrap();
    let conn = raw(&dbp(&dir, "svu.nothing"));
    let n: i64 = conn
        .query_row(
            &format!(
                "SELECT n FROM {}",
                nothing_core::schema::ident::view_sql_name(&view.id)
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 10);

    // invalid update leaves the old view intact
    let err = ws
        .update_view(
            &view.id,
            ViewPatch {
                config: Some(ViewConfig::Sql(SqlConfig {
                    statement: "DROP TABLE x".into(),
                })),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    let v = ws.get_view(&view.id).unwrap();
    assert!(matches!(v.config, ViewConfig::Sql(_)));
}
