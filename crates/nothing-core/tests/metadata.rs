//! Column presentation metadata (emoji icon, palette color, alignment,
//! default values) and the pre-release format reset.

mod common;

use common::{db_path, raw, PASSWORD};
use nothing_core::{
    AppError, ColumnColor, ColumnPatch, ColumnType, NewChoice, NewColumn, Workspace,
};

fn col(name: &str, t: ColumnType) -> NewColumn {
    NewColumn {
        name: name.into(),
        col_type: t,
        choices: Vec::new(),
        target_table_id: None,
        single: false,
        reverse_name: None,
        formula_expr: None,
        formula_result_type: None,
        icon: None,
        color: None,
        align: None,
        default_value: None,
    }
}

fn table_info(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .unwrap();
    stmt.query_map([table], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}

#[test]
fn fresh_workspace_is_current_version_and_has_one_node_table() {
    let (dir, ws) = common::create_ws("m.nothing");
    assert_eq!(
        ws.format_version().unwrap(),
        nothing_core::CURRENT_FORMAT_VERSION
    );
    let conn = raw(&db_path(&dir, "m.nothing"));
    let cols = table_info(&conn, "_meta");
    for name in [
        "parent_id",
        "kind",
        "icon",
        "color",
        "width",
        "col_type",
        "ref_id",
        "hidden",
    ] {
        assert!(cols.iter().any(|c| c == name), "missing {name}: {cols:?}");
    }
    // The old typed metadata tables are gone.
    assert!(table_info(&conn, "_columns").is_empty());
    assert!(table_info(&conn, "_tables").is_empty());
}

#[test]
fn obsolete_format_is_rejected() {
    let (dir, ws) = common::create_ws("old.nothing");
    let path = db_path(&dir, "old.nothing");
    drop(ws);
    {
        let conn = raw(&path);
        conn.execute(
            r#"UPDATE "_nothing" SET "value" = '3' WHERE "key" = 'format_version'"#,
            [],
        )
        .unwrap();
    }
    let err = Workspace::open(&path, PASSWORD).unwrap_err();
    assert!(matches!(err, AppError::FormatTooOld(3)), "{err:?}");
}

#[test]
fn icon_and_color_round_trip_and_clear() {
    let (_dir, ws) = common::create_ws("p.nothing");
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "状态".into(),
                    col_type: ColumnType::Select,
                    choices: Vec::new(),
                    target_table_id: None,
                    single: false,
                    reverse_name: None,
                    formula_expr: None,
                    formula_result_type: None,
                    icon: Some("🔥".into()),
                    color: Some("orange".into()),
                    align: None,
                    default_value: None,
                },
            ],
        )
        .unwrap();

    let cols = ws.list_columns(&table.id).unwrap();
    assert_eq!(cols[1].icon.as_deref(), Some("🔥"));
    assert_eq!(cols[1].color, Some(ColumnColor::Orange));

    // Clearing goes through empty strings (patch semantics).
    let updated = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                color: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(updated.color.is_none());
    assert_eq!(updated.icon.as_deref(), Some("🔥"));

    // Whitespace-only icon is normalized away.
    let updated = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                icon: Some("   ".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(updated.icon.is_none());
}

#[test]
fn option_icon_and_color_round_trip() {
    let (_dir, ws) = common::create_ws("option-icon.nothing");
    let choice = |id: &str, name: &str, icon: Option<&str>, color: Option<&str>| NewChoice {
        id: Some(id.into()),
        name: name.into(),
        icon: icon.map(str::to_string),
        color: color.map(str::to_string),
    };
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "状态".into(),
                    col_type: ColumnType::Select,
                    choices: vec![
                        choice("o1", "待办", Some("📝"), Some("blue")),
                        choice("o2", "完成", None, None),
                    ],
                    target_table_id: None,
                    single: false,
                    reverse_name: None,
                    formula_expr: None,
                    formula_result_type: None,
                    icon: None,
                    color: None,
                    align: None,
                    default_value: None,
                },
            ],
        )
        .unwrap();

    let cols = ws.list_columns(&table.id).unwrap();
    let choices = cols[1].choices();
    assert_eq!(choices[0].icon.as_deref(), Some("📝"));
    assert_eq!(choices[0].color, Some(ColumnColor::Blue));
    assert!(choices[1].icon.is_none());

    // Only presentation fields change: stable ids keep cell values intact.
    let updated = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                choices: Some(vec![
                    choice("o1", "待办", Some("🔥"), Some("orange")),
                    choice("o2", "完成", Some("✅"), Some("green")),
                ]),
                ..Default::default()
            },
        )
        .unwrap();
    let choices = updated.choices();
    assert_eq!(choices[0].id, "o1");
    assert_eq!(choices[0].icon.as_deref(), Some("🔥"));
    assert_eq!(choices[0].color, Some(ColumnColor::Orange));
    assert_eq!(choices[1].icon.as_deref(), Some("✅"));
    assert_eq!(choices[1].color, Some(ColumnColor::Green));

    // Empty / whitespace-only icon clears it.
    let cleared = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                choices: Some(vec![
                    choice("o1", "待办", Some("   "), None),
                    choice("o2", "完成", Some("✅"), Some("green")),
                ]),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(cleared.choices()[0].icon.is_none());
    assert!(cleared.choices()[0].color.is_none());

    // An invalid option icon rolls the whole option sync back.
    let err = ws
        .update_column(
            &table.id,
            &cols[1].id,
            ColumnPatch {
                choices: Some(vec![
                    choice("o1", "待办", Some(&"x".repeat(64)), Some("red")),
                    choice("o2", "完成", Some("✅"), Some("green")),
                ]),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    let after = ws.list_columns(&table.id).unwrap();
    assert!(after[1].choices()[0].icon.is_none());
    assert!(after[1].choices()[0].color.is_none());
}

#[test]
fn presentation_survives_a_type_change_rebuild() {
    let (_dir, ws) = common::create_ws("r.nothing");
    let table = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "数量".into(),
                    col_type: ColumnType::Text,
                    choices: Vec::new(),
                    target_table_id: None,
                    single: false,
                    reverse_name: None,
                    formula_expr: None,
                    formula_result_type: None,
                    icon: Some("🔢".into()),
                    color: Some("blue".into()),
                    align: None,
                    default_value: None,
                },
            ],
        )
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();

    // 铁律 2: type changes go through a full table rebuild — the metadata row
    // (and therefore icon/color) must survive it.
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
    assert_eq!(updated.icon.as_deref(), Some("🔢"));
    assert_eq!(updated.color, Some(ColumnColor::Blue));
}

#[test]
fn invalid_presentation_values_are_rejected() {
    let (_dir, ws) = common::create_ws("bad.nothing");
    let table = ws
        .create_table("任务", vec![col("标题", ColumnType::Text)])
        .unwrap();
    let cols = ws.list_columns(&table.id).unwrap();

    let err = ws
        .update_column(
            &table.id,
            &cols[0].id,
            ColumnPatch {
                color: Some("neon".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");

    let err = ws
        .update_column(
            &table.id,
            &cols[0].id,
            ColumnPatch {
                icon: Some("x".repeat(64)),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");

    // Neither failed write may leak into the stored metadata.
    let after = ws.list_columns(&table.id).unwrap();
    assert!(after[0].icon.is_none());
    assert!(after[0].color.is_none());
}

#[test]
fn table_icon_round_trip_and_clear() {
    let (_dir, ws) = common::create_ws("table-icon.nothing");
    let table = ws
        .create_table_with_icon("项目", vec![col("标题", ColumnType::Text)], Some("📊"))
        .unwrap();
    assert_eq!(table.icon.as_deref(), Some("📊"));
    assert_eq!(ws.get_table(&table.id).unwrap().icon.as_deref(), Some("📊"));

    // Whitespace-only clears; a later value sticks and is visible via list.
    let cleared = ws.set_table_icon(&table.id, Some("   ")).unwrap();
    assert!(cleared.icon.is_none());
    let updated = ws.set_table_icon(&table.id, Some("🚀")).unwrap();
    assert_eq!(updated.icon.as_deref(), Some("🚀"));
    assert_eq!(ws.list_tables().unwrap()[0].icon.as_deref(), Some("🚀"));

    // Invalid payloads are rejected before touching the row.
    let err = ws
        .set_table_icon(&table.id, Some(&"x".repeat(64)))
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    assert_eq!(ws.get_table(&table.id).unwrap().icon.as_deref(), Some("🚀"));
}

#[test]
fn create_table_with_invalid_icon_rolls_back() {
    let (_dir, ws) = common::create_ws("table-icon-bad.nothing");
    let err = ws
        .create_table_with_icon(
            "坏表",
            vec![col("标题", ColumnType::Text)],
            Some(&"x".repeat(64)),
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    assert!(ws.list_tables().unwrap().is_empty());
}
