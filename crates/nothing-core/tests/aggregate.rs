//! Summary-view integration tests: grouped aggregation, filter reuse, column
//! lifecycle and the v5→v6 migration surface.

use nothing_core::{
    AggregateConfig, AggregateMetric, AggregateOp, AggregateSort, ColumnPatch, ColumnType,
    FilterNode, FilterOp, FilterRule, GridConfig, NewView, ViewData, ViewKind, ViewResult,
    Workspace,
};

mod common;
use common::{col, create_ws, select_col};

use serde_json::json;

struct Fixture {
    table: nothing_core::TableMeta,
    cols: Vec<nothing_core::ColumnMeta>,
}

fn id_of<'a>(f: &'a Fixture, name: &str) -> &'a str {
    f.cols
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.id.as_str())
        .unwrap()
}

fn fixture(ws: &Workspace) -> Fixture {
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                col("工时", ColumnType::Number),
                select_col("状态", &["待办", "进行中", "完成"]),
                col("完成", ColumnType::Checkbox),
                col("日期", ColumnType::Date),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    let f = Fixture { table, cols };

    let rows = [
        ("A", Some(8.0), "待办", true, Some("2026-01-01")),
        ("B", Some(4.0), "进行中", false, Some("2026-01-01")),
        ("C", None, "完成", true, Some("2026-02-01")),
        ("D", Some(6.0), "待办", false, None),
        ("E", Some(2.0), "待办", true, Some("2026-01-01")),
    ];
    for (title, hours, status, done, date) in rows {
        let mut cells = std::collections::HashMap::new();
        cells.insert(id_of(&f, "标题").to_string(), json!(title));
        cells.insert(id_of(&f, "工时").to_string(), json!(hours));
        cells.insert(id_of(&f, "状态").to_string(), json!(status));
        cells.insert(id_of(&f, "完成").to_string(), json!(done));
        cells.insert(id_of(&f, "日期").to_string(), json!(date));
        ws.insert_row(&f.table.id, cells).unwrap();
    }
    f
}

fn summary(
    ws: &Workspace,
    f: &Fixture,
    name: &str,
    group_by: Vec<&str>,
    metrics: Vec<AggregateMetric>,
    sort: Option<AggregateSort>,
) -> nothing_core::ViewMeta {
    ws.create_view(NewView {
        table_id: Some(f.table.id.clone()),
        name: name.into(),
        kind: ViewKind::Grid,
        data: ViewData::Grid(GridConfig {
            filters: None,
            sorts: Vec::new(),
            aggregate: Some(AggregateConfig {
                group_by: group_by.into_iter().map(String::from).collect(),
                metrics,
                sort,
            }),
        }),
    })
    .unwrap()
}

fn run(ws: &Workspace, view_id: &str) -> nothing_core::AggregateResult {
    match ws.run_view(view_id, None, None).unwrap() {
        ViewResult::Aggregate(result) => result,
        ViewResult::Grid(_) => panic!("expected aggregate result"),
        ViewResult::Sql(_) => panic!("expected aggregate result"),
    }
}

fn metric(op: AggregateOp, col: Option<&str>) -> AggregateMetric {
    AggregateMetric {
        op,
        column_id: col.map(String::from),
    }
}

#[test]
fn groups_by_select_and_sums_numbers() {
    let (_dir, ws) = create_ws("agg-basic.nothing");
    let f = fixture(&ws);
    let view = summary(
        &ws,
        &f,
        "按状态汇总",
        vec![id_of(&f, "状态")],
        vec![
            metric(AggregateOp::CountRows, None),
            metric(AggregateOp::Sum, Some(id_of(&f, "工时"))),
        ],
        Some(AggregateSort {
            metric: Some(1),
            desc: true,
        }),
    );

    let result = run(&ws, &view.id);
    assert_eq!(result.total_groups, 3);
    assert_eq!(result.base_rows, 5);
    assert_eq!(result.columns.len(), 3);
    assert_eq!(
        result.columns[0].column_id.as_deref(),
        Some(id_of(&f, "状态"))
    );
    assert_eq!(result.columns[1].op, Some(AggregateOp::CountRows));
    assert_eq!(result.columns[2].op, Some(AggregateOp::Sum));

    // Sorted by sum(hours) DESC: 待办 16, 进行中 4, 完成 has only NULL → last.
    assert_eq!(result.rows[0][0], json!("待办"));
    assert_eq!(result.rows[0][1], json!(3));
    assert_eq!(result.rows[0][2], json!(16.0));
    assert_eq!(result.rows[1][0], json!("进行中"));
    assert_eq!(result.rows[1][1], json!(1));
    assert_eq!(result.rows[2][0], json!("完成"));
    assert_eq!(result.rows[2][1], json!(1));
    assert_eq!(result.rows[2][2], json!(null));
}

#[test]
fn no_grouping_is_one_grand_total_row() {
    let (_dir, ws) = create_ws("agg-total.nothing");
    let f = fixture(&ws);
    let view = summary(
        &ws,
        &f,
        "总计",
        vec![],
        vec![
            metric(AggregateOp::CountRows, None),
            metric(AggregateOp::Sum, Some(id_of(&f, "工时"))),
            metric(AggregateOp::Avg, Some(id_of(&f, "工时"))),
            metric(AggregateOp::CountNonEmpty, Some(id_of(&f, "工时"))),
            metric(AggregateOp::CountDistinct, Some(id_of(&f, "状态"))),
        ],
        None,
    );

    let result = run(&ws, &view.id);
    assert_eq!(result.total_groups, 1);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0][0], json!(5));
    assert_eq!(result.rows[0][1], json!(20.0));
    assert_eq!(result.rows[0][2], json!(5.0)); // avg ignores NULL
    assert_eq!(result.rows[0][3], json!(4));
    assert_eq!(result.rows[0][4], json!(3));
}

#[test]
fn filters_dates_and_checkboxes_work() {
    let (_dir, ws) = create_ws("agg-filters.nothing");
    let f = fixture(&ws);

    let base = summary(
        &ws,
        &f,
        "过滤",
        vec![id_of(&f, "完成")],
        vec![metric(AggregateOp::CountRows, None)],
        None,
    );
    let mut view = ws.get_view(&base.id).unwrap();
    if let ViewData::Grid(cfg) = &mut view.data {
        cfg.filters = Some(FilterNode::Rule(FilterRule {
            column_id: id_of(&f, "工时").to_string(),
            op: FilterOp::Gt,
            value: json!(3),
        }));
    }
    ws.update_view(
        &base.id,
        nothing_core::ViewPatch {
            data: Some(view.data),
            ..Default::default()
        },
    )
    .unwrap();

    let result = run(&ws, &base.id);
    assert_eq!(result.base_rows, 3); // 8, 4, 6
    assert_eq!(result.total_groups, 2); // true: A; false: B, D
    let true_row = result
        .rows
        .iter()
        .find(|r| r[0] == json!(1))
        .expect("checked group");
    assert_eq!(true_row[1], json!(1));
    let false_row = result
        .rows
        .iter()
        .find(|r| r[0] == json!(0))
        .expect("unchecked group");
    assert_eq!(false_row[1], json!(2));

    // Date grouping uses the UTC day, matching the `on` filter semantics.
    let dates = summary(
        &ws,
        &f,
        "按日期",
        vec![id_of(&f, "日期")],
        vec![metric(AggregateOp::CountRows, None)],
        None,
    );
    let result = run(&ws, &dates.id);
    assert_eq!(result.total_groups, 3); // 2026-01-01, 2026-02-01, NULL
    let day = result
        .rows
        .iter()
        .find(|r| r[0] == json!("2026-01-01"))
        .expect("January group");
    assert_eq!(day[1], json!(3));
}

#[test]
fn invalid_summaries_are_rejected() {
    let (_dir, ws) = create_ws("agg-invalid.nothing");
    let f = fixture(&ws);

    let create = |name: &str, group: Vec<&str>, metrics: Vec<AggregateMetric>| {
        ws.create_view(NewView {
            table_id: Some(f.table.id.clone()),
            name: name.into(),
            kind: ViewKind::Grid,
            data: ViewData::Grid(GridConfig {
                filters: None,
                sorts: Vec::new(),
                aggregate: Some(AggregateConfig {
                    group_by: group.into_iter().map(String::from).collect(),
                    metrics,
                    sort: None,
                }),
            }),
        })
    };

    assert!(matches!(
        create("空指标", vec![], vec![]),
        Err(nothing_core::AppError::InvalidInput(_))
    ));
    assert!(matches!(
        create(
            "文本求和",
            vec![],
            vec![metric(AggregateOp::Sum, Some(id_of(&f, "标题")))]
        ),
        Err(nothing_core::AppError::InvalidInput(_))
    ));
    assert!(matches!(
        create(
            "行数带列",
            vec![],
            vec![metric(AggregateOp::CountRows, Some(id_of(&f, "工时")))]
        ),
        Err(nothing_core::AppError::InvalidInput(_))
    ));
    assert!(matches!(
        create(
            "重复分组",
            vec![id_of(&f, "状态"), id_of(&f, "状态")],
            vec![metric(AggregateOp::CountRows, None)]
        ),
        Err(nothing_core::AppError::InvalidInput(_))
    ));
}

#[test]
fn deleting_a_column_prunes_the_summary_instead_of_breaking_it() {
    let (_dir, ws) = create_ws("agg-delete.nothing");
    let f = fixture(&ws);
    let view = summary(
        &ws,
        &f,
        "工时汇总",
        vec![id_of(&f, "状态")],
        vec![
            metric(AggregateOp::Sum, Some(id_of(&f, "工时"))),
            metric(AggregateOp::CountRows, None),
        ],
        Some(AggregateSort {
            metric: Some(0),
            desc: true,
        }),
    );

    ws.delete_column(&f.table.id, id_of(&f, "工时")).unwrap();
    let after = ws.get_view(&view.id).unwrap();
    let ViewData::Grid(cfg) = &after.data else {
        panic!("expected grid");
    };
    let aggregate = cfg.aggregate.as_ref().expect("summary stays a summary");
    assert_eq!(aggregate.metrics.len(), 1);
    assert_eq!(aggregate.metrics[0].op, AggregateOp::CountRows);
    assert!(aggregate.sort.is_none());

    let result = run(&ws, &view.id);
    assert_eq!(result.rows.len(), 3);
    let todo = result
        .rows
        .iter()
        .find(|r| r[0] == json!("待办"))
        .expect("待办 group");
    assert_eq!(todo[1], json!(3));
}

#[test]
fn column_type_change_is_refused_when_a_summary_depends_on_it() {
    let (_dir, ws) = create_ws("agg-type.nothing");
    let f = fixture(&ws);
    let view = summary(
        &ws,
        &f,
        "工时汇总",
        vec![],
        vec![metric(AggregateOp::Sum, Some(id_of(&f, "工时")))],
        None,
    );

    let err = ws
        .update_column(
            &f.table.id,
            id_of(&f, "工时"),
            ColumnPatch {
                col_type: Some(ColumnType::Text),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(
        err.to_string().contains("工时汇总"),
        "expected the view name in {err}"
    );

    // The summary still runs after the refused change.
    assert_eq!(run(&ws, &view.id).rows.len(), 1);
}

#[test]
fn aggregate_config_never_treats_column_ids_as_sql() {
    let (_dir, ws) = create_ws("agg-injection.nothing");
    let f = fixture(&ws);
    let evil = r#"c_1"; DROP TABLE t_x; --"#.to_string();
    let err = ws
        .create_view(NewView {
            table_id: Some(f.table.id.clone()),
            name: "注入".into(),
            kind: ViewKind::Grid,
            data: ViewData::Grid(GridConfig {
                filters: None,
                sorts: Vec::new(),
                aggregate: Some(AggregateConfig {
                    group_by: vec![evil],
                    metrics: vec![metric(AggregateOp::CountRows, None)],
                    sort: None,
                }),
            }),
        })
        .unwrap_err();
    assert!(
        matches!(err, nothing_core::AppError::NotFound(_)),
        "{err:?}"
    );

    // The rejected view did not reach SQL and the table is intact.
    assert_eq!(ws.list_rows(&f.table.id, None, None).unwrap().total, 5);
}

#[test]
fn summary_config_round_trips_through_metadata() {
    let (_dir, ws) = create_ws("agg-roundtrip.nothing");
    let f = fixture(&ws);
    let view = summary(
        &ws,
        &f,
        "往返",
        vec![id_of(&f, "状态")],
        vec![metric(AggregateOp::CountRows, None)],
        Some(AggregateSort {
            metric: Some(0),
            desc: true,
        }),
    );
    let loaded = ws.get_view(&view.id).unwrap();
    let ViewData::Grid(cfg) = &loaded.data else {
        panic!("expected grid");
    };
    let aggregate = cfg.aggregate.as_ref().unwrap();
    assert_eq!(aggregate.group_by, vec![id_of(&f, "状态").to_string()]);
    assert_eq!(aggregate.metrics[0].op, AggregateOp::CountRows);
    assert!(aggregate.sort.as_ref().unwrap().desc);
}
