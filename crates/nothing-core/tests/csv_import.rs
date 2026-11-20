//! CSV import: encoding/delimiter detection, header confirmation data, type
//! inference, transactional bulk insert and rollback behaviour.

mod common;

use std::collections::HashMap;

use nothing_core::{read_csv_preview, ColumnType, ImportCsvOptions, Workspace};

fn write_file(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    path.to_string_lossy().into_owned()
}

fn opts(path: &str, table: &str, headers: &[&str], types: &[ColumnType]) -> ImportCsvOptions {
    ImportCsvOptions {
        path: path.into(),
        table_name: table.into(),
        use_header: true,
        headers: headers.iter().map(|s| s.to_string()).collect(),
        types: types.to_vec(),
    }
}

/// Column name → id map for a freshly imported table.
fn col_ids(ws: &Workspace, table_id: &str) -> HashMap<String, String> {
    ws.list_columns(table_id)
        .unwrap()
        .into_iter()
        .map(|c| (c.name, c.id))
        .collect()
}

#[test]
fn preview_detects_types_and_utf8() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(
        &dir,
        "a.csv",
        "标题,数量,完成,截止\n苹果,3,是,2024-01-05\n香蕉,4.5,否,2024/02/06\n".as_bytes(),
    );

    let preview = read_csv_preview(&path, 20).unwrap();
    assert_eq!(preview.first_row, ["标题", "数量", "完成", "截止"]);
    assert_eq!(preview.rows.len(), 2);
    assert_eq!(preview.rows[1][0], "香蕉");
    assert_eq!(preview.total_rows, 3);
    assert_eq!(preview.width, 4);
    assert_eq!(preview.delimiter, ",");
    assert_eq!(preview.encoding, "utf-8");
    assert!(!preview.ragged);
    assert_eq!(
        preview.suggested_types,
        [
            ColumnType::Text,
            ColumnType::Number,
            ColumnType::Checkbox,
            ColumnType::Date
        ]
    );
}

#[test]
fn import_creates_table_and_converts_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(
        &dir,
        "a.csv",
        "标题,数量,完成,截止\n苹果,3,是,2024-01-05\n香蕉,4.5,否,2024/02/06\n".as_bytes(),
    );
    let preview = read_csv_preview(&path, 20).unwrap();
    let (_ws_dir, ws) = common::create_ws("ws.nothing");

    let report = ws
        .import_csv(opts(
            &path,
            "水果",
            &["标题", "数量", "完成", "截止"],
            &preview.suggested_types,
        ))
        .unwrap();
    assert_eq!(report.imported, 2);
    assert_eq!(report.invalid_cells, 0);
    assert_eq!(report.table.name, "水果");

    let cols = ws.list_columns(&report.table.id).unwrap();
    let types: Vec<ColumnType> = cols.iter().map(|c| c.col_type).collect();
    assert_eq!(
        types,
        [
            ColumnType::Text,
            ColumnType::Number,
            ColumnType::Checkbox,
            ColumnType::Date
        ]
    );

    let ids = col_ids(&ws, &report.table.id);
    let page = ws.list_rows(&report.table.id, None, None).unwrap();
    assert_eq!(page.total, 2);

    let apple = page
        .rows
        .iter()
        .find(|r| r.cells[&ids["标题"]] == serde_json::json!("苹果"))
        .expect("苹果 row");
    assert_eq!(apple.cells[&ids["数量"]], serde_json::json!(3.0));
    assert_eq!(apple.cells[&ids["完成"]], serde_json::json!(true));
    assert_eq!(apple.cells[&ids["截止"]], serde_json::json!("2024-01-05"));

    let banana = page
        .rows
        .iter()
        .find(|r| r.cells[&ids["标题"]] == serde_json::json!("香蕉"))
        .expect("香蕉 row");
    // Slash format was normalized to ISO date.
    assert_eq!(banana.cells[&ids["截止"]], serde_json::json!("2024-02-06"));
}

#[test]
fn import_reads_gb18030_and_strips_utf8_bom() {
    let dir = tempfile::tempdir().unwrap();
    let (gbk, _, _) = encoding_rs::GB18030.encode("标题,备注\n你好,世界\n");
    let gbk_path = write_file(&dir, "gbk.csv", &gbk);

    let preview = read_csv_preview(&gbk_path, 20).unwrap();
    assert_eq!(preview.encoding, "gb18030");
    assert_eq!(preview.first_row, ["标题", "备注"]);

    let (_ws_dir, ws) = common::create_ws("ws.nothing");
    let report = ws
        .import_csv(opts(
            &gbk_path,
            "中文",
            &["标题", "备注"],
            &[ColumnType::Text, ColumnType::Text],
        ))
        .unwrap();
    let ids = col_ids(&ws, &report.table.id);
    let page = ws.list_rows(&report.table.id, None, None).unwrap();
    assert_eq!(page.rows[0].cells[&ids["标题"]], serde_json::json!("你好"));
    assert_eq!(page.rows[0].cells[&ids["备注"]], serde_json::json!("世界"));

    let bom_path = write_file(
        &dir,
        "bom.csv",
        b"\xEF\xBB\xBF\xE6\xA0\x87\xE9\xA2\x98,\xE6\x95\xB0\xE9\x87\x8F\nA,1\n",
    );
    let bom = read_csv_preview(&bom_path, 20).unwrap();
    assert_eq!(bom.first_row[0], "标题");
    assert_eq!(bom.encoding, "utf-8");
}

#[test]
fn import_preserves_quoted_commas_and_newlines() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(
        &dir,
        "quoted.csv",
        b"\xE6\xA0\x87\xE9\xA2\x98,\xE5\xA4\x87\xE6\xB3\xA8\n\"\xE5\x90\xAB,\xE9\x80\x97\xE5\x8F\xB7\",1\n\"\xE5\xA4\x9A\n\xE8\xA1\x8C\",2\n",
    );
    let preview = read_csv_preview(&path, 20).unwrap();
    assert_eq!(preview.rows[0][0], "含,逗号");
    assert_eq!(preview.rows[1][0], "多\n行");

    let (_ws_dir, ws) = common::create_ws("ws.nothing");
    let report = ws
        .import_csv(opts(
            &path,
            "引用",
            &["标题", "备注"],
            &[ColumnType::Text, ColumnType::Number],
        ))
        .unwrap();
    let ids = col_ids(&ws, &report.table.id);
    let page = ws.list_rows(&report.table.id, None, None).unwrap();
    let row = page
        .rows
        .iter()
        .find(|r| r.cells[&ids["备注"]] == serde_json::json!(2.0))
        .unwrap();
    assert_eq!(row.cells[&ids["标题"]], serde_json::json!("多\n行"));
}

#[test]
fn import_without_header_keeps_first_row_as_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(&dir, "noheader.csv", b"a,b\n1,2\n");
    let (_ws_dir, ws) = common::create_ws("ws.nothing");

    let report = ws
        .import_csv(ImportCsvOptions {
            path,
            table_name: "无表头".into(),
            use_header: false,
            headers: vec!["第一列".into(), "第二列".into()],
            types: vec![ColumnType::Text, ColumnType::Number],
        })
        .unwrap();
    assert_eq!(report.imported, 2);

    let ids = col_ids(&ws, &report.table.id);
    let page = ws.list_rows(&report.table.id, None, None).unwrap();
    assert!(page
        .rows
        .iter()
        .any(|r| r.cells[&ids["第一列"]] == serde_json::json!("a")
            && r.cells[&ids["第二列"]] == serde_json::json!(null)));
    assert!(page
        .rows
        .iter()
        .any(|r| r.cells[&ids["第一列"]] == serde_json::json!("1")
            && r.cells[&ids["第二列"]] == serde_json::json!(2.0)));
}

#[test]
fn invalid_cells_become_null_and_are_counted() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(
        &dir,
        "bad.csv",
        "标题,数量,截止,完成\nA,abc,not-a-date,maybe\nB,2,2024-01-01,是\n".as_bytes(),
    );
    let (_ws_dir, ws) = common::create_ws("ws.nothing");
    let report = ws
        .import_csv(opts(
            &path,
            "坏值",
            &["标题", "数量", "截止", "完成"],
            &[
                ColumnType::Text,
                ColumnType::Number,
                ColumnType::Date,
                ColumnType::Checkbox,
            ],
        ))
        .unwrap();
    assert_eq!(report.imported, 2);
    assert_eq!(report.invalid_cells, 3);

    let ids = col_ids(&ws, &report.table.id);
    let page = ws.list_rows(&report.table.id, None, None).unwrap();
    let a = page
        .rows
        .iter()
        .find(|r| r.cells[&ids["标题"]] == serde_json::json!("A"))
        .unwrap();
    assert_eq!(a.cells[&ids["数量"]], serde_json::json!(null));
    assert_eq!(a.cells[&ids["截止"]], serde_json::json!(null));
    // Checkbox columns are NOT NULL: a bad value falls back to false.
    assert_eq!(a.cells[&ids["完成"]], serde_json::json!(false));
}

#[test]
fn duplicate_headers_roll_back_without_creating_a_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(&dir, "dup.csv", b"A,B\n1,2\n");
    let (_ws_dir, ws) = common::create_ws("ws.nothing");

    let err = ws
        .import_csv(opts(
            &path,
            "重复",
            &["同一", "同一"],
            &[ColumnType::Text, ColumnType::Text],
        ))
        .unwrap_err();
    assert!(matches!(err, nothing_core::AppError::AlreadyExists(_)));
    assert!(ws.list_tables().unwrap().is_empty());
}

#[test]
fn first_column_is_always_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(&dir, "num.csv", b"num,value\n123,5\n");
    let (_ws_dir, ws) = common::create_ws("ws.nothing");

    let report = ws
        .import_csv(opts(
            &path,
            "数字标题",
            &["num", "value"],
            &[ColumnType::Number, ColumnType::Number],
        ))
        .unwrap();
    let cols = ws.list_columns(&report.table.id).unwrap();
    assert_eq!(cols[0].col_type, ColumnType::Text);
    assert_eq!(cols[1].col_type, ColumnType::Number);

    let ids = col_ids(&ws, &report.table.id);
    let page = ws.list_rows(&report.table.id, None, None).unwrap();
    assert_eq!(page.rows[0].cells[&ids["num"]], serde_json::json!("123"));
}

#[test]
fn imported_rows_are_full_text_searchable() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(&dir, "fts.csv", "标题,备注\nhello world,foo\n".as_bytes());
    let (_ws_dir, ws) = common::create_ws("ws.nothing");

    let report = ws
        .import_csv(opts(
            &path,
            "搜索",
            &["标题", "备注"],
            &[ColumnType::Text, ColumnType::Text],
        ))
        .unwrap();
    let page = ws.search(&report.table.id, "hello", None, None).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.rows.len(), 1);
}

#[test]
fn ragged_rows_are_padded_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(&dir, "ragged.csv", b"A,B,C\n1,2\n3,4,5,6\n");
    let preview = read_csv_preview(&path, 20).unwrap();
    assert_eq!(preview.width, 4);
    assert!(preview.ragged);
    assert_eq!(preview.first_row.len(), 4);

    let (_ws_dir, ws) = common::create_ws("ws.nothing");
    let report = ws
        .import_csv(opts(
            &path,
            "参差",
            &["A", "B", "C", "D"],
            &[ColumnType::Text; 4],
        ))
        .unwrap();
    assert_eq!(report.imported, 2);
    let ids = col_ids(&ws, &report.table.id);
    let page = ws.list_rows(&report.table.id, None, None).unwrap();
    let first = page
        .rows
        .iter()
        .find(|r| r.cells[&ids["A"]] == serde_json::json!("1"))
        .unwrap();
    assert_eq!(first.cells[&ids["C"]], serde_json::json!(null));
    let second = page
        .rows
        .iter()
        .find(|r| r.cells[&ids["A"]] == serde_json::json!("3"))
        .unwrap();
    assert_eq!(second.cells[&ids["D"]], serde_json::json!("6"));
}

#[test]
fn semicolon_and_tab_delimiters_are_detected() {
    let dir = tempfile::tempdir().unwrap();
    let semi = write_file(&dir, "semi.csv", "标题;数量\nA;1\nB;2\n".as_bytes());
    let p = read_csv_preview(&semi, 20).unwrap();
    assert_eq!(p.delimiter, ";");
    assert_eq!(p.suggested_types, [ColumnType::Text, ColumnType::Number]);

    let tab = write_file(&dir, "tab.csv", "标题\t数量\nA\t1\n".as_bytes());
    let p = read_csv_preview(&tab, 20).unwrap();
    assert_eq!(p.delimiter, "\t");
    assert_eq!(p.first_row, ["标题", "数量"]);
}

#[test]
fn trailing_blank_lines_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(&dir, "blank.csv", b"A,B\r\n1,2\r\n\r\n");
    let preview = read_csv_preview(&path, 20).unwrap();
    assert_eq!(preview.total_rows, 2);
    assert_eq!(preview.rows.len(), 1);
    assert_eq!(preview.rows[0], ["1", "2"]);
}

#[test]
fn header_only_file_creates_an_empty_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_file(&dir, "head.csv", "A,B\n".as_bytes());
    let (_ws_dir, ws) = common::create_ws("ws.nothing");

    let report = ws
        .import_csv(opts(
            &path,
            "空表",
            &["A", "B"],
            &[ColumnType::Text, ColumnType::Text],
        ))
        .unwrap();
    assert_eq!(report.imported, 0);
    assert_eq!(ws.list_rows(&report.table.id, None, None).unwrap().total, 0);
}

#[test]
fn empty_or_unsupported_inputs_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let empty = write_file(&dir, "empty.csv", b"");
    let (_ws_dir, ws) = common::create_ws("ws.nothing");
    assert!(read_csv_preview(&empty, 20).is_err());

    let utf16 = write_file(&dir, "utf16.csv", b"\xFF\xFEA\x00,\x00B\x00\n\x00");
    let err = read_csv_preview(&utf16, 20).unwrap_err();
    assert!(matches!(err, nothing_core::AppError::InvalidInput(_)));
    assert!(err.to_string().contains("UTF-16"));

    let path = write_file(&dir, "a.csv", b"A,B\n1,2\n");
    let err = ws
        .import_csv(opts(
            &path,
            "非法",
            &["A", "B"],
            &[ColumnType::Text, ColumnType::Formula],
        ))
        .unwrap_err();
    assert!(matches!(err, nothing_core::AppError::InvalidInput(_)));
    assert!(ws.list_tables().unwrap().is_empty());
}
