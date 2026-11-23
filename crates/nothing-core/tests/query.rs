//! M2 query layer: row CRUD, grid-view compilation, FTS search, SQL view
//! execution (read-only), relation cells + batched titles.
//!
//! Includes the mandated malicious-input cases (铁律 4 / AGENTS.md 测试要求).

mod common;

use std::collections::HashMap;

use common::{emp_task_fixture, object_exists, raw};
use nothing_core::{
    AppError, Cells, ColumnType, FilterNode, FilterOp, FilterRule, FormulaResultType, GridConfig,
    LogicOp, NewView, SortSpec, SqlConfig, ViewColumnPatch, ViewData, ViewKind, ViewResult,
};

fn dbp(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

fn cells(entries: Vec<(&str, serde_json::Value)>) -> Cells {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

/// Fixture table exercising every column type.
struct Full {
    table: nothing_core::TableMeta,
    id: HashMap<String, String>,  // column name → id
    sql: HashMap<String, String>, // column name → physical sql name
}

fn full_fixture(ws: &nothing_core::Workspace) -> Full {
    let table = ws
        .create_table(
            "全类型",
            vec![
                common::col("标题", ColumnType::Text),
                common::col("工时", ColumnType::Number),
                common::select_col("状态", &["待办", "进行中", "完成"]),
                common::multi_select_col("标签", &["紧急", "常规"]),
                common::col("完成", ColumnType::Checkbox),
                common::col("截止", ColumnType::Date),
                common::formula_col("双倍工时", "[工时] * 2", FormulaResultType::Number),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let mut id = HashMap::new();
    let mut sql = HashMap::new();
    for c in &cols {
        id.insert(c.name.clone(), c.id.clone());
        sql.insert(c.name.clone(), c.sql_name().unwrap().to_string());
    }
    Full { table, id, sql }
}

impl Full {
    fn c(&self, name: &str) -> &str {
        self.id.get(name).unwrap()
    }
}

fn make_grid(ws: &nothing_core::Workspace, table_id: &str, name: &str, cfg: GridConfig) -> String {
    ws.create_view(NewView {
        table_id: Some(table_id.into()),
        name: name.into(),
        kind: ViewKind::Grid,
        data: ViewData::Grid(cfg),
    })
    .unwrap()
    .id
}

fn rule(col_id: &str, op: FilterOp, value: serde_json::Value) -> FilterNode {
    FilterNode::Rule(FilterRule {
        column_id: col_id.into(),
        op,
        value,
    })
}

fn run_grid(ws: &nothing_core::Workspace, view_id: &str) -> nothing_core::RowPage {
    match ws.run_view(view_id, None, None).unwrap() {
        ViewResult::Grid(page) => page,
        ViewResult::Sql(_) => panic!("expected grid result"),
    }
}

// ---------------------------------------------------------------------------
// Row CRUD
// ---------------------------------------------------------------------------

#[test]
fn row_crud_roundtrip() {
    let (_dir, ws) = common::create_ws("crud.nothing");
    let f = full_fixture(&ws);
    let t = &f.table.id;

    let row = ws
        .insert_row(
            t,
            cells(vec![
                (f.c("标题"), serde_json::json!("写周报")),
                (f.c("工时"), serde_json::json!(2.5)),
                (f.c("状态"), serde_json::json!("待办")),
                (f.c("标签"), serde_json::json!(["常规"])),
                (f.c("截止"), serde_json::json!("2026-12-01")),
            ]),
        )
        .unwrap();
    assert_eq!(row.cells[f.c("标题")], serde_json::json!("写周报"));
    assert_eq!(row.cells[f.c("工时")], serde_json::json!(2.5));
    assert_eq!(row.cells[f.c("标签")], serde_json::json!(["常规"]));
    assert_eq!(row.cells[f.c("完成")], serde_json::json!(false)); // default
    assert_eq!(row.cells[f.c("双倍工时")], serde_json::json!(5.0)); // generated!

    // partial update
    let updated = ws
        .update_row(
            t,
            &row.rid,
            cells(vec![
                (f.c("完成"), serde_json::json!(true)),
                (f.c("工时"), serde_json::json!(3)),
            ]),
        )
        .unwrap();
    assert_eq!(updated.cells[f.c("完成")], serde_json::json!(true));
    assert_eq!(updated.cells[f.c("标题")], serde_json::json!("写周报"));
    assert_eq!(updated.cells[f.c("双倍工时")], serde_json::json!(6.0));
    assert!(updated.updated >= row.updated);

    // get_row
    let fetched = ws.get_row(t, &row.rid).unwrap();
    assert_eq!(fetched.rid, row.rid);

    // batch update
    let r2 = ws
        .insert_row(t, cells(vec![(f.c("标题"), serde_json::json!("评审"))]))
        .unwrap();
    let n = ws
        .batch_update(
            t,
            vec![
                (
                    row.rid.clone(),
                    cells(vec![(f.c("状态"), serde_json::json!("完成"))]),
                ),
                (
                    r2.rid.clone(),
                    cells(vec![(f.c("状态"), serde_json::json!("进行中"))]),
                ),
            ],
        )
        .unwrap();
    assert_eq!(n, 2);
    assert_eq!(
        ws.get_row(t, &row.rid).unwrap().cells[f.c("状态")],
        serde_json::json!("完成")
    );

    // delete
    assert_eq!(
        ws.delete_rows(t, &[row.rid.clone(), r2.rid.clone()])
            .unwrap(),
        2
    );
    assert!(matches!(
        ws.get_row(t, &row.rid).unwrap_err(),
        AppError::NotFound(_)
    ));
    assert_eq!(ws.delete_rows(t, &[]).unwrap(), 0);
    // updating a ghost row fails atomically
    let err = ws
        .update_row(
            t,
            &row.rid,
            cells(vec![(f.c("工时"), serde_json::json!(1))]),
        )
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}

#[test]
fn cell_validation_rejects_bad_values() {
    let (_dir, ws) = common::create_ws("val.nothing");
    let f = full_fixture(&ws);
    let t = &f.table.id;

    // invalid select choice
    let err = ws
        .insert_row(t, cells(vec![(f.c("状态"), serde_json::json!("摸鱼"))]))
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    // invalid item in multi select
    let err = ws
        .insert_row(
            t,
            cells(vec![(f.c("标签"), serde_json::json!(["紧急", "??"]))]),
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    // number column rejects junk string
    let err = ws
        .insert_row(t, cells(vec![(f.c("工时"), serde_json::json!("很多"))]))
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    // checkbox rejects 5
    let err = ws
        .insert_row(t, cells(vec![(f.c("完成"), serde_json::json!(5))]))
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    // formula column is not writable
    let err = ws
        .insert_row(t, cells(vec![(f.c("双倍工时"), serde_json::json!(1))]))
        .unwrap_err();
    assert!(matches!(err, AppError::Rejected(_)), "{err:?}");
    // unknown column id
    let err = ws
        .insert_row(t, cells(vec![("GHOSTCOL", serde_json::json!(1))]))
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    // invalid date is caught by the database CHECK
    let err = ws
        .insert_row(t, cells(vec![(f.c("截止"), serde_json::json!("不是日期"))]))
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

// ---------------------------------------------------------------------------
// Relations via row API
// ---------------------------------------------------------------------------

#[test]
fn relation_cells_titles_and_reverse_editing() {
    let (_dir, ws) = common::create_ws("relq.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();
    let emp_cols = ws.list_columns(&f.emp_table.id).unwrap();
    let reverse = emp_cols.iter().find(|c| c.is_reverse()).unwrap();
    let emp_name = &emp_cols[0].id;

    let zhang = ws
        .insert_row(
            &f.emp_table.id,
            cells(vec![(emp_name, serde_json::json!("张三"))]),
        )
        .unwrap();
    let li = ws
        .insert_row(
            &f.emp_table.id,
            cells(vec![(emp_name, serde_json::json!("李四"))]),
        )
        .unwrap();
    let task = ws
        .insert_row(
            &f.task_table.id,
            cells(vec![
                (&f.task_cols[0].id, serde_json::json!("上线部署")),
                (rel.id.as_str(), serde_json::json!([zhang.rid, li.rid])),
            ]),
        )
        .unwrap();
    assert_eq!(
        task.cells[rel.id.as_str()],
        serde_json::json!([zhang.rid, li.rid])
    );

    // list_rows batches titles for referenced rows
    let page = ws.list_rows(&f.task_table.id, None, None).unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(
        page.titles.get(&zhang.rid).map(String::as_str),
        Some("张三")
    );
    assert_eq!(page.titles.get(&li.rid).map(String::as_str), Some("李四"));

    // editing through the reverse column writes the same junction table
    let updated_emp = ws
        .update_row(
            &f.emp_table.id,
            &zhang.rid,
            cells(vec![(reverse.id.as_str(), serde_json::json!([]))]),
        )
        .unwrap();
    assert_eq!(
        updated_emp.cells[reverse.id.as_str()],
        serde_json::json!([])
    );
    let task_after = ws.get_row(&f.task_table.id, &task.rid).unwrap();
    assert_eq!(
        task_after.cells[rel.id.as_str()],
        serde_json::json!([li.rid])
    );

    // linking to a non-existent row → NotFound, nothing partially written
    let err = ws
        .update_row(
            &f.task_table.id,
            &task.rid,
            cells(vec![(rel.id.as_str(), serde_json::json!(["GHOSTRID"]))]),
        )
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    let task_after = ws.get_row(&f.task_table.id, &task.rid).unwrap();
    assert_eq!(
        task_after.cells[rel.id.as_str()],
        serde_json::json!([li.rid])
    );

    // deleting the employee row cascades the link out of the task's cell
    ws.delete_rows(&f.emp_table.id, std::slice::from_ref(&li.rid))
        .unwrap();
    let task_after = ws.get_row(&f.task_table.id, &task.rid).unwrap();
    assert_eq!(task_after.cells[rel.id.as_str()], serde_json::json!([]));
}

// ---------------------------------------------------------------------------
// Grid views: filters, sorts, pagination
// ---------------------------------------------------------------------------

fn seed_rows(ws: &nothing_core::Workspace, f: &Full) -> Vec<String> {
    let specs = [
        ("alpha", 1.0, "待办", true, "2026-01-15"),
        ("beta", 5.0, "进行中", false, "2026-06-01"),
        ("gamma", 9.0, "完成", true, "2026-03-20"),
        ("delta", 5.0, "进行中", false, "2026-12-31"),
    ];
    specs
        .iter()
        .map(|(title, hours, status, done, date)| {
            ws.insert_row(
                &f.table.id,
                cells(vec![
                    (f.c("标题"), serde_json::json!(title)),
                    (f.c("工时"), serde_json::json!(hours)),
                    (f.c("状态"), serde_json::json!(status)),
                    (f.c("完成"), serde_json::json!(done)),
                    (f.c("截止"), serde_json::json!(date)),
                ]),
            )
            .unwrap()
            .rid
        })
        .collect()
}

#[test]
fn grid_view_filters_sorts_hidden_and_pagination() {
    let (_dir, ws) = common::create_ws("grid.nothing");
    let f = full_fixture(&ws);
    seed_rows(&ws, &f);
    // one row without 工时 (NULL) to check NULLS LAST
    ws.insert_row(
        &f.table.id,
        cells(vec![(f.c("标题"), serde_json::json!("epsilon"))]),
    )
    .unwrap();

    let view = make_grid(
        &ws,
        &f.table.id,
        "v1",
        GridConfig {
            filters: Some(rule(f.c("工时"), FilterOp::Gt, serde_json::json!(2))),
            sorts: vec![SortSpec {
                column_id: f.c("工时").to_string(),
                desc: true,
            }],
        },
    );
    ws.update_view_column(
        &view,
        f.c("完成"),
        ViewColumnPatch {
            hidden: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let page = run_grid(&ws, &view);
    assert_eq!(page.total, 3); // 5.0, 9.0, 5.0
    let titles: Vec<&str> = page
        .rows
        .iter()
        .map(|r| r.cells[f.c("标题")].as_str().unwrap())
        .collect();
    assert_eq!(titles, vec!["gamma", "beta", "delta"]);
    // hidden column excluded everywhere
    assert!(page.columns.iter().all(|c| c.name != "完成"));
    assert!(page.rows.iter().all(|r| !r.cells.contains_key(f.c("完成"))));
    // formula column present and correct
    assert_eq!(page.rows[0].cells[f.c("双倍工时")], serde_json::json!(18.0));

    // NULLS LAST: unsorted view keeps NULL 工时 at the end when sorting desc
    let view2 = make_grid(
        &ws,
        &f.table.id,
        "v2",
        GridConfig {
            filters: None,
            sorts: vec![SortSpec {
                column_id: f.c("工时").to_string(),
                desc: true,
            }],
        },
    );
    let page = run_grid(&ws, &view2);
    assert_eq!(page.total, 5);
    assert_eq!(
        page.rows.last().unwrap().cells[f.c("标题")].as_str(),
        Some("epsilon")
    );

    // pagination
    let paged = match ws.run_view(&view2, Some(2), Some(1)).unwrap() {
        ViewResult::Grid(p) => p,
        _ => panic!(),
    };
    assert_eq!(paged.total, 5); // total ignores paging
    assert_eq!(paged.rows.len(), 2);
    assert_eq!(paged.rows[0].cells[f.c("标题")].as_str(), Some("beta"));
}

#[test]
fn filter_ops_coverage() {
    let (_dir, ws) = common::create_ws("ops.nothing");
    let f = full_fixture(&ws);
    seed_rows(&ws, &f);

    let view = make_grid(&ws, &f.table.id, "v", GridConfig::default());
    let set_cfg = |cfg: GridConfig| {
        ws.update_view(
            &view,
            nothing_core::ViewPatch {
                data: Some(ViewData::Grid(cfg)),
                ..Default::default()
            },
        )
        .unwrap();
    };
    let titles = || {
        let page = run_grid(&ws, &view);
        let mut t: Vec<String> = page
            .rows
            .iter()
            .map(|r| r.cells[f.c("标题")].as_str().unwrap().to_string())
            .collect();
        t.sort();
        (page.total, t)
    };

    // text contains / starts / ends / empty
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("标题"),
            FilterOp::Contains,
            serde_json::json!("eta"),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["beta"]);
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("标题"),
            FilterOp::StartsWith,
            serde_json::json!("g"),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["gamma"]);
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("标题"),
            FilterOp::EndsWith,
            serde_json::json!("ta"),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["beta", "delta"]);

    // select In / Neq
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("状态"),
            FilterOp::In,
            serde_json::json!(["待办", "完成"]),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["alpha", "gamma"]);
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("状态"),
            FilterOp::Neq,
            serde_json::json!("进行中"),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["alpha", "gamma"]);

    // checkbox Eq
    set_cfg(GridConfig {
        filters: Some(rule(f.c("完成"), FilterOp::Eq, serde_json::json!(true))),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["alpha", "gamma"]);

    // date Before / On
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("截止"),
            FilterOp::Before,
            serde_json::json!("2026-06-01"),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["alpha", "gamma"]);
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("截止"),
            FilterOp::On,
            serde_json::json!("2026-06-01"),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["beta"]);

    // formula column filter (generated, filterable like a number)
    set_cfg(GridConfig {
        filters: Some(rule(f.c("双倍工时"), FilterOp::Gte, serde_json::json!(10))),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["beta", "delta", "gamma"]);

    // number IsEmpty / IsNotEmpty
    let extra = ws
        .insert_row(
            &f.table.id,
            cells(vec![(f.c("标题"), serde_json::json!("nohours"))]),
        )
        .unwrap();
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("工时"),
            FilterOp::IsEmpty,
            serde_json::Value::Null,
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["nohours"]);

    // nested groups: (状态=进行中 AND 完成=false) OR 标题=alpha
    set_cfg(GridConfig {
        filters: Some(FilterNode::Group {
            op: LogicOp::Or,
            children: vec![
                FilterNode::Group {
                    op: LogicOp::And,
                    children: vec![
                        rule(f.c("状态"), FilterOp::Eq, serde_json::json!("进行中")),
                        rule(f.c("完成"), FilterOp::Eq, serde_json::json!(false)),
                    ],
                },
                rule(f.c("标题"), FilterOp::Eq, serde_json::json!("alpha")),
            ],
        }),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["alpha", "beta", "delta"]);

    // multi select: add tags then filter Contains
    ws.batch_update(
        &f.table.id,
        vec![
            (
                extra.rid.clone(),
                cells(vec![(f.c("标签"), serde_json::json!(["紧急", "常规"]))]),
            ),
            (
                titles_row(&ws, &f, "alpha"),
                cells(vec![(f.c("标签"), serde_json::json!(["常规"]))]),
            ),
        ],
    )
    .unwrap();
    set_cfg(GridConfig {
        filters: Some(rule(
            f.c("标签"),
            FilterOp::Contains,
            serde_json::json!("紧急"),
        )),
        ..Default::default()
    });
    assert_eq!(titles().1, vec!["nohours"]);

    // unsupported combos are rejected, not silently ignored
    let err = ws
        .update_view(
            &view,
            nothing_core::ViewPatch {
                data: Some(ViewData::Grid(GridConfig {
                    filters: Some(rule(
                        f.c("完成"),
                        FilterOp::Contains,
                        serde_json::json!("x"),
                    )),
                    ..Default::default()
                })),
                ..Default::default()
            },
        )
        .and_then(|_| ws.run_view(&view, None, None))
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

fn titles_row(ws: &nothing_core::Workspace, f: &Full, title: &str) -> String {
    ws.search(&f.table.id, title, None, None)
        .unwrap()
        .rows
        .iter()
        .find(|r| r.cells[f.c("标题")].as_str() == Some(title))
        .unwrap()
        .rid
        .clone()
}

#[test]
fn relation_filters_empty_not_empty() {
    let (_dir, ws) = common::create_ws("relf.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, None),
        )
        .unwrap();
    let emp_cols = ws.list_columns(&f.emp_table.id).unwrap();
    let emp = ws
        .insert_row(
            &f.emp_table.id,
            cells(vec![(&emp_cols[0].id, serde_json::json!("张三"))]),
        )
        .unwrap();
    let t1 = ws
        .insert_row(
            &f.task_table.id,
            cells(vec![
                (&f.task_cols[0].id, serde_json::json!("有主任务")),
                (rel.id.as_str(), serde_json::json!([emp.rid])),
            ]),
        )
        .unwrap();
    ws.insert_row(
        &f.task_table.id,
        cells(vec![(&f.task_cols[0].id, serde_json::json!("无主任务"))]),
    )
    .unwrap();

    let view = make_grid(
        &ws,
        &f.task_table.id,
        "有负责人",
        GridConfig {
            filters: Some(rule(
                rel.id.as_str(),
                FilterOp::IsNotEmpty,
                serde_json::Value::Null,
            )),
            ..Default::default()
        },
    );
    let page = run_grid(&ws, &view);
    assert_eq!(page.total, 1);
    assert_eq!(page.rows[0].rid, t1.rid);
    assert_eq!(page.titles.get(&emp.rid).map(String::as_str), Some("张三"));

    ws.update_view(
        &view,
        nothing_core::ViewPatch {
            data: Some(ViewData::Grid(GridConfig {
                filters: Some(rule(
                    rel.id.as_str(),
                    FilterOp::IsEmpty,
                    serde_json::Value::Null,
                )),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(run_grid(&ws, &view).total, 1);
    let _ = t1;
}

// ---------------------------------------------------------------------------
// Malicious input (铁律 4)
// ---------------------------------------------------------------------------

#[test]
fn filter_values_are_data_never_sql() {
    let (dir, ws) = common::create_ws("evil.nothing");
    let f = full_fixture(&ws);
    let t = &f.table.id;

    let payloads = [
        "x'; DROP TABLE _meta; --",
        "x' OR '1'='1",
        "x\"); DELETE FROM whatever; --",
        "-- comment",
        "'; ATTACH DATABASE ':memory:' AS pwn; --",
    ];
    for p in &payloads {
        ws.insert_row(t, cells(vec![(f.c("标题"), serde_json::json!(p))]))
            .unwrap();
    }
    ws.insert_row(t, cells(vec![(f.c("标题"), serde_json::json!("正常行"))]))
        .unwrap();

    let view = make_grid(&ws, t, "evil", GridConfig::default());
    for p in &payloads {
        // Eq matches exactly the one seeded row — proving the payload was
        // bound as data.
        ws.update_view(
            &view,
            nothing_core::ViewPatch {
                data: Some(ViewData::Grid(GridConfig {
                    filters: Some(rule(f.c("标题"), FilterOp::Eq, serde_json::json!(p))),
                    ..Default::default()
                })),
                ..Default::default()
            },
        )
        .unwrap();
        let page = run_grid(&ws, &view);
        assert_eq!(page.total, 1, "payload {p:?}");
        assert_eq!(page.rows[0].cells[f.c("标题")].as_str().unwrap(), *p);

        // Contains with the payload as substring also matches only that row
        ws.update_view(
            &view,
            nothing_core::ViewPatch {
                data: Some(ViewData::Grid(GridConfig {
                    filters: Some(rule(f.c("标题"), FilterOp::Contains, serde_json::json!(p))),
                    ..Default::default()
                })),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(run_grid(&ws, &view).total, 1, "contains {p:?}");
    }

    // Everything still exists.
    assert_eq!(ws.list_tables().unwrap().len(), 1);
    let conn = raw(&dbp(&dir, "evil.nothing"));
    assert!(object_exists(&conn, "_meta"));
    assert!(object_exists(&conn, &f.table.sql_name));
    assert!(ws.schema_objects("pwn%").unwrap().is_empty());

    // tautology payload as a *value* must not act as a tautology
    ws.update_view(
        &view,
        nothing_core::ViewPatch {
            data: Some(ViewData::Grid(GridConfig {
                filters: Some(rule(
                    f.c("标题"),
                    FilterOp::Eq,
                    serde_json::json!("anything' OR '1'='1"),
                )),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(run_grid(&ws, &view).total, 0);
}

#[test]
fn like_wildcards_are_escaped_in_values() {
    let (_dir, ws) = common::create_ws("wild.nothing");
    let f = full_fixture(&ws);
    let t = &f.table.id;
    ws.insert_row(
        t,
        cells(vec![(f.c("标题"), serde_json::json!("100%_done"))]),
    )
    .unwrap();
    ws.insert_row(t, cells(vec![(f.c("标题"), serde_json::json!("1001done"))]))
        .unwrap();
    ws.insert_row(t, cells(vec![(f.c("标题"), serde_json::json!("50% off"))]))
        .unwrap();

    let view = make_grid(&ws, t, "w", GridConfig::default());
    // "%" as a search value must match only rows containing a literal %
    ws.update_view(
        &view,
        nothing_core::ViewPatch {
            data: Some(ViewData::Grid(GridConfig {
                filters: Some(rule(
                    f.c("标题"),
                    FilterOp::Contains,
                    serde_json::json!("%"),
                )),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(run_grid(&ws, &view).total, 2);
    // "100%_" matches only the literal
    ws.update_view(
        &view,
        nothing_core::ViewPatch {
            data: Some(ViewData::Grid(GridConfig {
                filters: Some(rule(
                    f.c("标题"),
                    FilterOp::Contains,
                    serde_json::json!("100%_"),
                )),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .unwrap();
    let page = run_grid(&ws, &view);
    assert_eq!(page.total, 1);
    assert_eq!(page.rows[0].cells[f.c("标题")].as_str(), Some("100%_done"));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[test]
fn search_uses_fts_then_like_fallback() {
    let (_dir, ws) = common::create_ws("search.nothing");
    let f = full_fixture(&ws);
    let t = &f.table.id;
    for title in [
        "数据库系统概念",
        "编译原理",
        "操作系统入门",
        "Designing Data Intensive Applications",
    ] {
        ws.insert_row(t, cells(vec![(f.c("标题"), serde_json::json!(title))]))
            .unwrap();
    }
    // >= 3 chars → FTS trigram path (CJK substring)
    let page = ws.search(t, "数据库", None, None).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(
        page.rows[0].cells[f.c("标题")].as_str(),
        Some("数据库系统概念")
    );
    // ASCII substring, case-sensitive trigram
    let page = ws.search(t, "Intensive", None, None).unwrap();
    assert_eq!(page.total, 1);
    // < 3 chars → LIKE fallback ("入门" only occurs in 操作系统入门)
    let page = ws.search(t, "入门", None, None).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(
        page.rows[0].cells[f.c("标题")].as_str(),
        Some("操作系统入门")
    );
    // no match
    assert_eq!(ws.search(t, "量子力学", None, None).unwrap().total, 0);
    // wildcards in query are data
    assert_eq!(ws.search(t, "%", None, None).unwrap().total, 0);
    // empty query rejected
    assert!(matches!(
        ws.search(t, "  ", None, None).unwrap_err(),
        AppError::InvalidInput(_)
    ));
}

// ---------------------------------------------------------------------------
// SQL views / ad-hoc SQL
// ---------------------------------------------------------------------------

#[test]
fn sql_view_execution_and_join() {
    let (_dir, ws) = common::create_ws("sqlv.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();
    let emp_cols = ws.list_columns(&f.emp_table.id).unwrap();
    let emp = ws
        .insert_row(
            &f.emp_table.id,
            cells(vec![(&emp_cols[0].id, serde_json::json!("张三"))]),
        )
        .unwrap();
    ws.insert_row(
        &f.task_table.id,
        cells(vec![
            (&f.task_cols[0].id, serde_json::json!("部署")),
            (&f.task_cols[1].id, serde_json::json!(8)),
            (rel.id.as_str(), serde_json::json!([emp.rid])),
        ]),
    )
    .unwrap();
    ws.insert_row(
        &f.task_table.id,
        cells(vec![
            (&f.task_cols[0].id, serde_json::json!("测试")),
            (&f.task_cols[1].id, serde_json::json!(4)),
            (rel.id.as_str(), serde_json::json!([emp.rid])),
        ]),
    )
    .unwrap();

    let junction = nothing_core::schema::ident::junction_sql_name(&rel.id);
    let view = ws
        .create_view(NewView {
            table_id: None,
            name: "员工工时汇总".into(),
            kind: ViewKind::Sql,
            data: ViewData::Sql(SqlConfig {
                statement: format!(
                    r#"SELECT e.{emp_title} AS 员工, count(*) AS 任务数, sum(t.{hours}) AS 总工时
                       FROM {emp} e
                       JOIN {junction} j ON j.b = e._rid
                       JOIN {task} t ON t._rid = j.a
                       GROUP BY e._rid"#,
                    emp_title = emp_cols[0].sql_name().unwrap(),
                    emp = f.emp_table.sql_name,
                    hours = f.task_cols[1].sql_name().unwrap(),
                    task = f.task_table.sql_name,
                ),
            }),
        })
        .unwrap();

    let result = ws.run_sql_view(&view.id, None, None).unwrap();
    assert_eq!(
        result
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        vec!["员工", "任务数", "总工时"]
    );
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0][0], serde_json::json!("张三"));
    assert_eq!(result.rows[0][1], serde_json::json!(2));
    assert_eq!(result.rows[0][2], serde_json::json!(12.0));

    // run_view dispatches SQL views to the columnar result
    match ws.run_view(&view.id, None, None).unwrap() {
        ViewResult::Sql(r) => assert_eq!(r.rows.len(), 1),
        _ => panic!("expected sql result"),
    }

    // window functions work (SQLite feature, beyond Notion)
    let ranked = ws
        .run_sql(
            &format!(
                r#"WITH x AS (SELECT {title} AS t, {hours} AS h FROM {task})
                   SELECT t, h, rank() OVER (ORDER BY h DESC) AS rk FROM x ORDER BY h DESC"#,
                title = f.task_cols[0].sql_name().unwrap(),
                hours = f.task_cols[1].sql_name().unwrap(),
                task = f.task_table.sql_name
            ),
            Some(10),
            None,
        )
        .unwrap();
    assert_eq!(ranked.rows[0][2], serde_json::json!(1)); // h=8 ranks first
}

#[test]
fn run_sql_is_read_only() {
    let (dir, ws) = common::create_ws("ro.nothing");
    let f = emp_task_fixture(&ws);
    let conn = raw(&dbp(&dir, "ro.nothing"));
    let before = common::raw_count(&conn, &f.task_table.sql_name);
    drop(conn);

    for evil in [
        format!("DELETE FROM {}", f.task_table.sql_name),
        format!("UPDATE {} SET _rid = 'x'", f.task_table.sql_name),
        "DROP TABLE _meta".to_string(),
        "PRAGMA query_only = OFF".to_string(),
        format!("SELECT 1; DELETE FROM {}", f.task_table.sql_name),
        "CREATE TABLE hacked (x)".to_string(),
    ] {
        let err = ws.run_sql(&evil, None, None).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "{evil} → {err:?}");
    }

    // data and schema untouched; read connection still enforces query_only
    let conn = raw(&dbp(&dir, "ro.nothing"));
    assert_eq!(common::raw_count(&conn, &f.task_table.sql_name), before);
    assert!(!object_exists(&conn, "hacked"));
    assert!(object_exists(&conn, "_meta"));

    // a legitimate SELECT still works afterwards
    let r = ws
        .run_sql(
            &format!("SELECT count(*) AS n FROM {}", f.task_table.sql_name),
            None,
            None,
        )
        .unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(before));
}

#[test]
#[ignore = "performance smoke test; run with --ignored"]
fn perf_100k_rows_grid_view() {
    let (dir, ws) = common::create_ws("perf.nothing");
    let f = full_fixture(&ws);
    let conn = raw(&dbp(&dir, "perf.nothing"));
    let sql = &f.table.sql_name;
    let (c_title, c_hours, c_status) = (
        &f.sql_name("标题"),
        &f.sql_name("工时"),
        &f.sql_name("状态"),
    );
    let now = now();
    conn.execute_batch("BEGIN").unwrap();
    for i in 0..100_000 {
        conn.execute(
            &format!(
                r#"INSERT INTO "{sql}" ("_rid","_created","_updated","{c_title}","{c_hours}","{c_status}")
                   VALUES (?1,?2,?2,?3,?4,?5)"#
            ),
            rusqlite::params![
                format!("r{i:06}"),
                now,
                format!("任务 {i}"),
                (i % 1000) as f64,
                if i % 3 == 0 { "待办" } else { "进行中" },
            ],
        )
        .unwrap();
    }
    conn.execute_batch("COMMIT").unwrap();
    drop(conn);

    let view = make_grid(
        &ws,
        &f.table.id,
        "perf",
        GridConfig {
            filters: Some(FilterNode::Group {
                op: LogicOp::And,
                children: vec![
                    rule(f.c("状态"), FilterOp::Eq, serde_json::json!("待办")),
                    rule(f.c("工时"), FilterOp::Gt, serde_json::json!(500)),
                ],
            }),
            sorts: vec![SortSpec {
                column_id: f.c("工时").to_string(),
                desc: true,
            }],
        },
    );
    let start = std::time::Instant::now();
    let page = run_grid(&ws, &view);
    let elapsed = start.elapsed();
    println!(
        "100k rows → filtered total={}, page={}, elapsed={elapsed:?}",
        page.total,
        page.rows.len()
    );
    assert!(page.total > 0);
    assert!(
        elapsed.as_millis() < 2000,
        "grid view too slow: {elapsed:?}"
    );

    let start = std::time::Instant::now();
    let found = ws
        .search(&f.table.id, "任务 99999", Some(10), None)
        .unwrap();
    println!("search elapsed={:?} hits={}", start.elapsed(), found.total);
    assert_eq!(found.total, 1);

    let start = std::time::Instant::now();
    let r = ws
        .run_sql(
            &format!(
                r#"SELECT "{c_status}", count(*) n, sum("{c_hours}") s FROM "{sql}" GROUP BY 1"#
            ),
            None,
            None,
        )
        .unwrap();
    println!("sql agg elapsed={:?} rows={:?}", start.elapsed(), r.rows);
    assert_eq!(r.rows.len(), 2);
}

impl Full {
    fn sql_name(&self, name: &str) -> &str {
        self.sql.get(name).unwrap()
    }
}

fn now() -> String {
    nothing_core::schema::ident::now_iso()
}

// ---------------------------------------------------------------------------
// Password change must keep the read connection usable
// ---------------------------------------------------------------------------

#[test]
fn change_password_reopens_read_connection() {
    let (dir, ws) = common::create_ws("pw.nothing");
    let f = emp_task_fixture(&ws);
    ws.insert_row(
        &f.task_table.id,
        cells(vec![(&f.task_cols[0].id, serde_json::json!("改密前行"))]),
    )
    .unwrap();
    ws.change_password("brand-new-pass").unwrap();
    // read path (separate connection) must work with the new key
    let page = ws.list_rows(&f.task_table.id, None, None).unwrap();
    assert_eq!(page.total, 1);
    let r = ws
        .run_sql(
            &format!("SELECT count(*) FROM {}", f.task_table.sql_name),
            None,
            None,
        )
        .unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(1));
    // reopen with new password
    drop(ws);
    nothing_core::Workspace::open(dbp(&dir, "pw.nothing"), "brand-new-pass").unwrap();
}
