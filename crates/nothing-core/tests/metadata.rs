//! Column presentation metadata (emoji icon + palette color) and the
//! v1 → v2 format migration that introduced it (铁律 7).

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
    assert!(cols.iter().any(|c| c == "icon"), "{cols:?}");
    assert!(cols.iter().any(|c| c == "color"), "{cols:?}");
}

#[test]
fn v1_workspace_upgrades_in_place_and_keeps_metadata() {
    let (dir, ws) = common::create_ws("old.nothing");
    let table = ws
        .create_table("任务", vec![col("标题", ColumnType::Text)])
        .unwrap();
    let path = db_path(&dir, "old.nothing");
    drop(ws);

    // Rewind a current file to the v1 shape.
    {
        let conn = raw(&path);
        conn.execute_batch(
            r#"
            ALTER TABLE "_columns" DROP COLUMN "icon";
            ALTER TABLE "_columns" DROP COLUMN "color";
            UPDATE "_nothing" SET "value" = '1' WHERE "key" = 'format_version';
            "#,
        )
        .unwrap();
        assert!(!table_info(&conn, "_columns").iter().any(|c| c == "icon"));
    }

    let ws = Workspace::open(&path, PASSWORD).unwrap();
    assert_eq!(ws.format_version().unwrap(), 2);
    // Upgraded file still knows its table and columns.
    let cols = ws.list_columns(&table.id).unwrap();
    assert_eq!(cols.len(), 1);
    assert_eq!(cols[0].name, "标题");
    assert!(cols[0].icon.is_none());
    assert!(cols[0].color.is_none());
    drop(ws);

    // Re-opening an already-migrated file is a no-op (idempotent step).
    let ws = Workspace::open(&path, PASSWORD).unwrap();
    assert_eq!(ws.format_version().unwrap(), 2);
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
fn create_table_rejects_unknown_color() {
    let (_dir, ws) = common::create_ws("bad2.nothing");
    let err = ws
        .create_table(
            "任务",
            vec![
                col("标题", ColumnType::Text),
                NewColumn {
                    name: "状态".into(),
                    col_type: ColumnType::Text,
                    opts: None,
                    icon: None,
                    color: Some("magenta".into()),
                },
            ],
        )
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}
