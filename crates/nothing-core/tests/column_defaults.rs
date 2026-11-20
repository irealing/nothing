//! Column alignment, defaults (including the dynamic date default) and
//! metadata-only reordering.

mod common;

use nothing_core::{
    AppError, Cells, Choice, ColumnAlign, ColumnOpts, ColumnPatch, ColumnType, FormulaResultType,
    NewColumn, SelectOpts,
};

fn col(name: &str, t: ColumnType) -> NewColumn {
    NewColumn {
        name: name.into(),
        col_type: t,
        opts: None,
        icon: None,
        color: None,
        align: None,
        default_value: None,
    }
}

#[test]
fn align_round_trip_and_clear() {
    let (_dir, ws) = common::create_ws("align.nothing");
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "工时".into(),
                    col_type: ColumnType::Number,
                    opts: None,
                    icon: None,
                    color: None,
                    align: Some("center".into()),
                    default_value: None,
                },
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    assert_eq!(cols[1].align, Some(ColumnAlign::Center));

    let updated = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                align: Some("right".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.align, Some(ColumnAlign::Right));

    // Empty string clears back to "by type".
    let cleared = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                align: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(cleared.align.is_none());

    let err = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                align: Some("diagonal".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    assert_eq!(
        ws.list_columns(&table.id).unwrap()[1].align,
        None,
        "failed patch must not leak"
    );
}

#[test]
fn default_values_apply_to_new_rows_only() {
    let (_dir, ws) = common::create_ws("defaults.nothing");
    let mut status = common::select_col("状态", &["待办", "完成"]);
    status.default_value = Some(serde_json::json!("待办"));
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "工时".into(),
                    col_type: ColumnType::Number,
                    opts: None,
                    icon: None,
                    color: None,
                    align: None,
                    default_value: Some(serde_json::json!(8)),
                },
                status,
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    assert_eq!(cols[1].default_value, Some(serde_json::json!(8)));
    assert_eq!(cols[2].default_value, Some(serde_json::json!("待办")));

    // Missing cells pick up the defaults…
    let row = ws.insert_row(&table.id, Cells::new()).unwrap();
    assert_eq!(row.cells[&cols[1].id], serde_json::json!(8.0));
    assert_eq!(row.cells[&cols[2].id], serde_json::json!("待办"));

    // …while explicitly supplied cells win (including an explicit null).
    let mut cells = Cells::new();
    cells.insert(cols[1].id.clone(), serde_json::json!(100));
    cells.insert(cols[2].id.clone(), serde_json::Value::Null);
    let row = ws.insert_row(&table.id, cells).unwrap();
    assert_eq!(row.cells[&cols[1].id], serde_json::json!(100.0));
    assert_eq!(row.cells[&cols[2].id], serde_json::Value::Null);

    // Changing the default affects later rows only.
    ws.update_column(
        &table.id,
        &cols[1].id,
        ColumnPatch {
            default_value: Some(serde_json::json!(7)),
            ..Default::default()
        },
    )
    .unwrap();
    let row = ws.insert_row(&table.id, Cells::new()).unwrap();
    assert_eq!(row.cells[&cols[1].id], serde_json::json!(7.0));
    assert_eq!(
        ws.get_row(&table.id, &row.rid).unwrap().cells[&cols[1].id],
        serde_json::json!(7.0)
    );

    // Explicit clear_default removes the default.
    let cleared = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                clear_default: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(cleared.default_value.is_none());
    let row = ws.insert_row(&table.id, Cells::new()).unwrap();
    assert_eq!(row.cells[&cols[1].id], serde_json::Value::Null);
}

#[test]
fn date_now_default_is_resolved_on_insert() {
    let (_dir, ws) = common::create_ws("now-default.nothing");
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "开始".into(),
                    col_type: ColumnType::Date,
                    opts: None,
                    icon: None,
                    color: None,
                    align: None,
                    default_value: Some(serde_json::json!({ "kind": "now" })),
                },
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    assert_eq!(
        cols[1].default_value,
        Some(serde_json::json!({ "kind": "now" }))
    );

    let row = ws.insert_row(&table.id, Cells::new()).unwrap();
    let value = row.cells[&cols[1].id].as_str().unwrap_or_default();
    assert!(value.ends_with('Z') && value.contains('T'), "{value}");
    assert!(value.len() > 10, "{value}");

    // The token is rejected everywhere except date columns.
    let err = ws
        .update_column(
            &table.id,
            &cols[0].id,
            ColumnPatch {
                default_value: Some(serde_json::json!({ "kind": "now" })),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

#[test]
fn default_value_validation_rejects_unsupported_columns_and_values() {
    let (_dir, ws) = common::create_ws("defaults-bad.nothing");
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                col("工时", ColumnType::Number),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();

    // Wrong literal type for the column.
    let err = ws
        .create_table(
            "坏表",
            vec![NewColumn {
                name: "数字".into(),
                col_type: ColumnType::Number,
                opts: None,
                icon: None,
                color: None,
                align: None,
                default_value: Some(serde_json::json!("abc")),
            }],
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    // A rejected create must not leave a table behind.
    assert!(!ws.list_tables().unwrap().iter().any(|t| t.name == "坏表"));

    // Empty-choices select cannot have a default.
    let mut empty = common::select_col("空选项", &[]);
    empty.default_value = Some(serde_json::json!("A"));
    let err = ws.add_column(&table.id, empty).unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");

    // A value outside the choice list is rejected.
    let mut bad_choice = common::select_col("状态", &["待办"]);
    bad_choice.default_value = Some(serde_json::json!("完成"));
    let err = ws.add_column(&table.id, bad_choice).unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");

    // Relation and formula columns have no defaults.
    let mut relation = common::relation_col("关联", &table.id, None);
    relation.default_value = Some(serde_json::json!([]));
    let err = ws.add_column(&table.id, relation).unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");

    let mut formula = common::formula_col("合计", "[工时] * 2", FormulaResultType::Number);
    formula.default_value = Some(serde_json::json!(1));
    let err = ws.add_column(&table.id, formula).unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");

    // Date literals are validated like the table CHECK constraint.
    let updated = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                col_type: Some(ColumnType::Date),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.col_type, ColumnType::Date);
    let err = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                default_value: Some(serde_json::json!("not-a-date")),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

#[test]
fn type_change_clears_incompatible_default_and_choices_change_prunes_it() {
    let (_dir, ws) = common::create_ws("defaults-migrate.nothing");
    let mut status = common::select_col("状态", &["待办", "完成"]);
    status.default_value = Some(serde_json::json!("完成"));
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "值".into(),
                    col_type: ColumnType::Text,
                    opts: None,
                    icon: None,
                    color: None,
                    align: None,
                    default_value: Some(serde_json::json!("abc")),
                },
                status,
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();

    // Text → Number cannot keep a non-numeric default: it is cleared, not an
    // error.
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
    assert!(updated.default_value.is_none());

    // Removing the defaulted choice prunes the default.
    let updated = ws
        .update_column(
            &table.id,
            &cols[2].id,
            ColumnPatch {
                opts: Some(ColumnOpts::Select(SelectOpts {
                    choices: vec![Choice {
                        id: "1".into(),
                        name: "待办".into(),
                    }],
                })),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(updated.default_value.is_none());
}

#[test]
fn column_position_patch_reorders_columns() {
    let (_dir, ws) = common::create_ws("reorder.nothing");
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                col("甲", ColumnType::Text),
                col("乙", ColumnType::Text),
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();
    ws.update_column(
        &table.id,
        &cols[2].id,
        ColumnPatch {
            position: Some(0),
            ..Default::default()
        },
    )
    .unwrap();
    let names: Vec<String> = ws
        .list_columns(&table.id)
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(names, ["乙", "标题", "甲"]);
    let positions: Vec<i64> = ws
        .list_columns(&table.id)
        .unwrap()
        .into_iter()
        .map(|c| c.position)
        .collect();
    assert_eq!(positions, [0, 1, 2], "positions stay dense");
}
