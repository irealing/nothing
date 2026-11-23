//! Views: grid view metadata CRUD + validation; SQL views are stored
//! statements executed read-only (no physical `CREATE VIEW` object).

mod common;

use common::{emp_task_fixture, raw, raw_insert_row};
use nothing_core::{
    AppError, FilterNode, FilterOp, FilterRule, GridConfig, LogicOp, NewView, SortSpec, SqlConfig,
    ViewColumnPatch, ViewData, ViewKind, ViewPatch,
};

fn dbp(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

fn grid_view(name: &str, table_id: Option<String>, cfg: GridConfig) -> NewView {
    NewView {
        table_id,
        name: name.into(),
        kind: ViewKind::Grid,
        data: ViewData::Grid(cfg),
    }
}

fn sql_view(name: &str, statement: String) -> NewView {
    NewView {
        table_id: None,
        name: name.into(),
        kind: ViewKind::Sql,
        data: ViewData::Sql(SqlConfig { statement }),
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
            },
        ))
        .unwrap();
    assert_eq!(view.kind, ViewKind::Grid);
    assert_eq!(view.table_id.as_deref(), Some(f.task_table.id.as_str()));
    // The view materializes its own column nodes for every table column.
    assert_eq!(view.columns.len(), 2);

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

    // update name + config + per-view column layout
    let updated = ws
        .update_view(
            &view.id,
            ViewPatch {
                name: Some("高工时".into()),
                data: Some(ViewData::Grid(GridConfig {
                    filters: None,
                    sorts: vec![SortSpec {
                        column_id: hours_col.clone(),
                        desc: true,
                    }],
                })),
                columns: Some(vec![ViewColumnPatch {
                    column_id: hours_col.clone(),
                    width: Some(240),
                    hidden: Some(true),
                    ..Default::default()
                }]),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.name, "高工时");
    let layout = updated
        .columns
        .iter()
        .find(|c| c.column_id == hours_col)
        .unwrap();
    assert_eq!(layout.width, 240);
    assert!(layout.hidden);

    ws.delete_view(&view.id).unwrap();
    assert!(matches!(
        ws.get_view(&view.id).unwrap_err(),
        AppError::NotFound(_)
    ));
    let _ = title_col;
}

#[test]
fn view_columns_are_independent_per_view() {
    let (_dir, ws) = common::create_ws("vcol.nothing");
    let f = emp_task_fixture(&ws);
    let hours_col = f.task_cols[1].id.clone();
    let a = ws
        .create_view(grid_view(
            "A",
            Some(f.task_table.id.clone()),
            GridConfig::default(),
        ))
        .unwrap();
    let b = ws
        .create_view(grid_view(
            "B",
            Some(f.task_table.id.clone()),
            GridConfig::default(),
        ))
        .unwrap();

    ws.update_view_column(
        &a.id,
        &hours_col,
        ViewColumnPatch {
            width: Some(320),
            hidden: Some(true),
            ..Default::default()
        },
    )
    .unwrap();

    let a2 = ws.get_view(&a.id).unwrap();
    let b2 = ws.get_view(&b.id).unwrap();
    let a_hours = a2
        .columns
        .iter()
        .find(|c| c.column_id == hours_col)
        .unwrap();
    let b_hours = b2
        .columns
        .iter()
        .find(|c| c.column_id == hours_col)
        .unwrap();
    assert_eq!(a_hours.width, 320);
    assert!(a_hours.hidden);
    // The other view is untouched.
    assert_eq!(b_hours.width, 160);
    assert!(!b_hours.hidden);
}

#[test]
fn sql_view_is_metadata_only_and_runs_read_only() {
    let (dir, ws) = common::create_ws("sv.nothing");
    let f = emp_task_fixture(&ws);
    let conn = raw(&dbp(&dir, "sv.nothing"));
    raw_insert_row(&conn, &f.task_table.sql_name, "t1");
    raw_insert_row(&conn, &f.task_table.sql_name, "t2");
    drop(conn);

    let statement = format!(
        "SELECT _rid AS id, {} AS title FROM {} ORDER BY _rid",
        f.task_cols[0].sql_name().unwrap(),
        f.task_table.sql_name
    );
    let view = ws.create_view(sql_view("全部任务", statement)).unwrap();

    // No physical CREATE VIEW object exists any more.
    assert!(ws.schema_objects("v_%").unwrap().is_empty());
    let result = ws.run_sql_view(&view.id, None, None).unwrap();
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0][0], serde_json::json!("t1"));

    // Multi-table SQL view still works (the killer feature vs grid views).
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
    let joined = ws.run_sql_view(&join_view.id, None, None).unwrap();
    assert_eq!(joined.rows.len(), 0);

    ws.delete_view(&view.id).unwrap();
    assert!(ws.schema_objects("v_%").unwrap().is_empty());
}

#[test]
fn sql_view_validation_rejects_non_select() {
    let (_dir, ws) = common::create_ws("svv.nothing");
    let f = emp_task_fixture(&ws);
    let bad = [
        format!("DELETE FROM {}", f.task_table.sql_name),
        format!("UPDATE {} SET _rid = 'x'", f.task_table.sql_name),
        format!("DROP TABLE {}", f.task_table.sql_name),
        "INSERT INTO _meta VALUES (1,2,3,4,5,6,7,8)".to_string(),
        format!("SELECT 1; DROP TABLE {}", f.task_table.sql_name),
        "PRAGMA key = 'hack'".to_string(),
        "/* SELECT */ DROP TABLE _meta".to_string(),
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
fn sql_view_update_changes_stored_statement() {
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
    drop(conn);
    let r = ws.run_sql_view(&view.id, None, None).unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(1));

    ws.update_view(
        &view.id,
        ViewPatch {
            data: Some(ViewData::Sql(SqlConfig {
                statement: format!("SELECT count(*) * 10 AS n FROM {}", f.task_table.sql_name),
            })),
            ..Default::default()
        },
    )
    .unwrap();
    let r = ws.run_sql_view(&view.id, None, None).unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(10));

    // invalid update leaves the old statement intact
    let err = ws
        .update_view(
            &view.id,
            ViewPatch {
                data: Some(ViewData::Sql(SqlConfig {
                    statement: "DROP TABLE x".into(),
                })),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    let v = ws.get_view(&view.id).unwrap();
    assert!(matches!(v.data, ViewData::Sql(_)));
    assert_eq!(
        ws.run_sql_view(&view.id, None, None).unwrap().rows[0][0],
        serde_json::json!(10)
    );
}
