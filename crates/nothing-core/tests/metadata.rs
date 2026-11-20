//! Column presentation metadata (emoji icon, palette color, alignment,
//! default values) and the format migrations that introduced it (铁律 7).

mod common;

use common::{db_path, raw, PASSWORD};
use nothing_core::{AppError, ColumnColor, ColumnPatch, ColumnType, NewColumn, Workspace};

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
fn fresh_workspace_is_current_version_and_has_presentation_columns() {
    let (dir, ws) = common::create_ws("m.nothing");
    assert_eq!(
        ws.format_version().unwrap(),
        nothing_core::CURRENT_FORMAT_VERSION
    );
    let conn = raw(&db_path(&dir, "m.nothing"));
    let cols = table_info(&conn, "_columns");
    for name in ["icon", "color", "align", "default_value"] {
        assert!(cols.iter().any(|c| c == name), "missing {name}: {cols:?}");
    }
}

#[test]
fn v2_workspace_upgrades_to_v3() {
    let (dir, ws) = common::create_ws("old-v2.nothing");
    let table = ws
        .create_table("任务", vec![col("标题", ColumnType::Text)])
        .unwrap();
    let path = db_path(&dir, "old-v2.nothing");
    drop(ws);

    // Rewind a current file to the v2 shape (alignment/defaults absent).
    {
        let conn = raw(&path);
        conn.execute_batch(
            r#"
            ALTER TABLE "_columns" DROP COLUMN "align";
            ALTER TABLE "_columns" DROP COLUMN "default_value";
            UPDATE "_nothing" SET "value" = '2' WHERE "key" = 'format_version';
            "#,
        )
        .unwrap();
        assert!(!table_info(&conn, "_columns").iter().any(|c| c == "align"));
    }

    let ws = Workspace::open(&path, PASSWORD).unwrap();
    assert_eq!(
        ws.format_version().unwrap(),
        nothing_core::CURRENT_FORMAT_VERSION
    );
    // Upgraded file still knows its table and columns.
    let cols = ws.list_columns(&table.id).unwrap();
    assert_eq!(cols.len(), 1);
    assert_eq!(cols[0].name, "标题");
    assert!(cols[0].align.is_none());
    assert!(cols[0].default_value.is_none());
    drop(ws);

    // Re-opening an already-migrated file is a no-op (idempotent step).
    let ws = Workspace::open(&path, PASSWORD).unwrap();
    assert_eq!(
        ws.format_version().unwrap(),
        nothing_core::CURRENT_FORMAT_VERSION
    );
}

#[test]
fn v1_workspace_upgrades_through_to_v3() {
    let (dir, ws) = common::create_ws("old-v1.nothing");
    let table = ws
        .create_table("任务", vec![col("标题", ColumnType::Text)])
        .unwrap();
    let path = db_path(&dir, "old-v1.nothing");
    drop(ws);

    // Rewind all the way to the v1 shape.
    {
        let conn = raw(&path);
        conn.execute_batch(
            r#"
            ALTER TABLE "_columns" DROP COLUMN "icon";
            ALTER TABLE "_columns" DROP COLUMN "color";
            ALTER TABLE "_columns" DROP COLUMN "align";
            ALTER TABLE "_columns" DROP COLUMN "default_value";
            UPDATE "_nothing" SET "value" = '1' WHERE "key" = 'format_version';
            "#,
        )
        .unwrap();
    }

    let ws = Workspace::open(&path, PASSWORD).unwrap();
    assert_eq!(
        ws.format_version().unwrap(),
        nothing_core::CURRENT_FORMAT_VERSION
    );
    let cols = ws.list_columns(&table.id).unwrap();
    assert_eq!(cols.len(), 1);
    assert!(cols[0].icon.is_none());
    assert!(cols[0].color.is_none());
    assert!(cols[0].align.is_none());
    assert!(cols[0].default_value.is_none());
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
                    opts: None,
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
                    opts: None,
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
