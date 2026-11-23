//! CSV import: preview parsing plus transactional table creation.
//!
//! The frontend asks for a preview first (first row + a few data rows + the
//! inferred column types), lets the user confirm/edit the header row, then
//! calls [`Workspace::import_csv`]. Import re-reads the file and creates the
//! table plus every row inside **one** transaction (铁律 1): a failure leaves
//! no half-imported table behind.
//!
//! Parsing rules:
//! - UTF-8 (with or without BOM) is tried first; invalid UTF-8 falls back to
//!   GB18030 (Excel on Chinese Windows).
//! - Delimiter is sniffed from the first line (`,` `;` `\t`).
//! - Ragged rows are padded with empty cells; the widest row defines the
//!   column count (capped by the table column limit).

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::Workspace;
use crate::error::{AppError, Result};
use crate::query::json_to_stored;
use crate::schema::ident::{new_id, now_iso, quote_ident};
use crate::schema::table::{create_table_tx, map_sqlite_err, MAX_COLUMNS};
use crate::schema::{load_columns, ColumnType, NewColumn, TableMeta};

/// Upper bound for a CSV file read into memory.
const MAX_CSV_BYTES: u64 = 64 * 1024 * 1024;

/// Preview rows returned to the UI (capped so IPC stays small).
const MAX_PREVIEW_ROWS: usize = 100;

/// Result of parsing a CSV file for the confirmation dialog.
#[derive(Debug, Clone, Serialize)]
pub struct CsvPreview {
    /// The first record, used as the editable header row by default.
    pub first_row: Vec<String>,
    /// Data rows after the first record (at most `preview_rows`).
    pub rows: Vec<Vec<String>>,
    /// Total number of records in the file (including the first one).
    pub total_rows: usize,
    /// Column count = width of the widest record.
    pub width: usize,
    /// Detected delimiter: `,`, `;` or a tab.
    pub delimiter: String,
    /// `utf-8` or `gb18030`.
    pub encoding: String,
    /// True when some records have a different cell count.
    pub ragged: bool,
    /// Inferred type per column (`text`/`number`/`date`/`checkbox`).
    /// The first column is always `text` because it becomes the title column.
    pub suggested_types: Vec<ColumnType>,
}

/// Arguments for [`Workspace::import_csv`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportCsvOptions {
    pub path: String,
    pub table_name: String,
    /// When true the first record is treated as the header and skipped.
    pub use_header: bool,
    /// Final column names (already edited by the user), one per CSV column.
    pub headers: Vec<String>,
    /// Column types, one per CSV column. The first column is forced to text.
    pub types: Vec<ColumnType>,
}

/// Outcome of a successful import.
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub table: TableMeta,
    pub imported: i64,
    /// Cells that did not match the chosen type and were stored as NULL.
    pub invalid_cells: i64,
}

struct ParsedCsv {
    records: Vec<Vec<String>>,
    width: usize,
    delimiter: String,
    encoding: &'static str,
    ragged: bool,
}

fn read_file(path: &str) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(Path::new(path))?;
    if meta.len() == 0 {
        return Err(AppError::InvalidInput("CSV 文件为空".into()));
    }
    if meta.len() > MAX_CSV_BYTES {
        return Err(AppError::InvalidInput(format!(
            "CSV 文件过大（上限 {} MB）",
            MAX_CSV_BYTES / (1024 * 1024)
        )));
    }
    Ok(std::fs::read(path)?)
}

/// Decode the file: UTF-8 (optional BOM) first, GB18030 otherwise.
fn decode(bytes: Vec<u8>) -> (String, &'static str) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(s) = std::str::from_utf8(rest) {
            return (s.to_string(), "utf-8");
        }
    }
    match String::from_utf8(bytes) {
        Ok(s) => (s, "utf-8"),
        Err(e) => {
            let bytes = e.into_bytes();
            let (cow, _, _) = encoding_rs::GB18030.decode(&bytes);
            (cow.into_owned(), "gb18030")
        }
    }
}

/// Sniff the delimiter from the first line, ignoring quoted sections.
fn detect_delimiter(text: &str) -> u8 {
    const CANDIDATES: [u8; 3] = *b",;\t";
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut counts = [0usize; CANDIDATES.len()];
    let mut quoted = false;
    for b in first.bytes() {
        if b == b'"' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        for (i, c) in CANDIDATES.iter().enumerate() {
            if b == *c {
                counts[i] += 1;
            }
        }
    }
    let best = counts
        .iter()
        .enumerate()
        .max_by_key(|(_, n)| **n)
        .map(|(i, _)| i)
        .unwrap_or(0);
    // All zero → single column; comma is the conventional display value.
    CANDIDATES[best]
}

fn parse_csv(path: &str) -> Result<ParsedCsv> {
    let bytes = read_file(path)?;
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(AppError::InvalidInput(
            "暂不支持 UTF-16 编码的 CSV，请另存为 UTF-8 或 GBK".into(),
        ));
    }
    let (text, encoding) = decode(bytes);
    if text.trim().is_empty() {
        return Err(AppError::InvalidInput("CSV 文件没有可导入的内容".into()));
    }
    let delim = detect_delimiter(&text);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delim)
        .from_reader(text.as_bytes());

    let mut records: Vec<Vec<String>> = Vec::new();
    for rec in reader.records() {
        let rec = rec.map_err(|e| AppError::InvalidInput(format!("CSV 解析失败: {e}")))?;
        records.push(rec.iter().map(|s| s.to_string()).collect());
    }
    if records.is_empty() {
        return Err(AppError::InvalidInput("CSV 文件没有可导入的内容".into()));
    }

    let width = records.iter().map(Vec::len).max().unwrap_or(0);
    if width > MAX_COLUMNS {
        return Err(AppError::InvalidInput(format!(
            "CSV 列数超过上限（{MAX_COLUMNS}）"
        )));
    }
    let ragged = records.iter().any(|r| r.len() != width);
    for r in &mut records {
        r.resize(width, String::new());
    }

    Ok(ParsedCsv {
        records,
        width,
        delimiter: (delim as char).to_string(),
        encoding,
        ragged,
    })
}

fn parse_number(s: &str) -> Option<f64> {
    let n: f64 = s.trim().parse().ok()?;
    n.is_finite().then_some(n)
}

/// Accept common spreadsheet date shapes and normalize to ISO8601 so the
/// table's `CHECK(datetime(...) IS NOT NULL)` always passes.
fn parse_date_value(raw: &str) -> Option<String> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(
            dt.with_timezone(&Utc)
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string(),
        );
    }
    const DATE_TIME_FORMATS: &[&str] = &[
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ];
    for f in DATE_TIME_FORMATS {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Some(dt.format("%Y-%m-%dT%H:%M:%S").to_string());
        }
    }
    const DATE_FORMATS: &[&str] = &["%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y%m%d"];
    for f in DATE_FORMATS {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return Some(d.format("%Y-%m-%d").to_string());
        }
    }
    None
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "y" | "是" | "✓" | "✔" | "1" => Some(true),
        "false" | "no" | "n" | "否" | "✗" | "x" | "×" | "0" => Some(false),
        _ => None,
    }
}

#[derive(Default, Clone, Copy)]
struct TypeStats {
    nonempty: usize,
    numeric: usize,
    date: usize,
    boolean: usize,
}

/// Infer column types from the data rows (first record assumed to be a header).
fn infer_types(records: &[Vec<String>], width: usize) -> Vec<ColumnType> {
    let mut stats = vec![TypeStats::default(); width];
    for rec in records.iter().skip(1) {
        for (i, cell) in rec.iter().enumerate() {
            let s = cell.trim();
            if s.is_empty() {
                continue;
            }
            let st = &mut stats[i];
            st.nonempty += 1;
            let numeric = parse_number(s).is_some();
            let boolean = parse_bool(s).is_some();
            if numeric {
                st.numeric += 1;
            }
            if boolean {
                st.boolean += 1;
            }
            // Dates are only relevant when the cell is neither numeric nor
            // boolean (those two types win the inference order).
            if !numeric && !boolean && parse_date_value(s).is_some() {
                st.date += 1;
            }
        }
    }

    let mut types: Vec<ColumnType> = stats
        .iter()
        .map(|st| {
            if st.nonempty == 0 {
                ColumnType::Text
            } else if st.numeric == st.nonempty {
                ColumnType::Number
            } else if st.boolean == st.nonempty {
                ColumnType::Checkbox
            } else if st.date == st.nonempty {
                ColumnType::Date
            } else {
                ColumnType::Text
            }
        })
        .collect();
    // The title column must be text (schema invariant).
    if let Some(first) = types.first_mut() {
        *first = ColumnType::Text;
    }
    types
}

/// Parse a file for the confirmation dialog without touching the workspace.
pub fn read_csv_preview(path: &str, preview_rows: usize) -> Result<CsvPreview> {
    let parsed = parse_csv(path)?;
    let take = preview_rows.clamp(1, MAX_PREVIEW_ROWS);
    Ok(CsvPreview {
        first_row: parsed.records[0].clone(),
        rows: parsed.records.iter().skip(1).take(take).cloned().collect(),
        total_rows: parsed.records.len(),
        width: parsed.width,
        delimiter: parsed.delimiter,
        encoding: parsed.encoding.to_string(),
        ragged: parsed.ragged,
        suggested_types: infer_types(&parsed.records, parsed.width),
    })
}

/// Convert one raw CSV cell into the JSON value shape of a column type.
/// Failure is not fatal: the cell becomes NULL and is counted.
fn coerce_cell(t: ColumnType, raw: &str, invalid: &mut i64) -> serde_json::Value {
    use serde_json::Value;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // Checkbox columns are NOT NULL DEFAULT 0; an empty cell means false.
        return if t == ColumnType::Checkbox {
            Value::Bool(false)
        } else {
            Value::Null
        };
    }
    match t {
        ColumnType::Text => Value::String(raw.to_string()),
        ColumnType::Number => match parse_number(trimmed) {
            Some(n) => Value::from(n),
            None => {
                *invalid += 1;
                Value::Null
            }
        },
        ColumnType::Date => match parse_date_value(trimmed) {
            Some(d) => Value::String(d),
            None => {
                *invalid += 1;
                Value::Null
            }
        },
        ColumnType::Checkbox => match parse_bool(trimmed) {
            Some(b) => Value::Bool(b),
            None => {
                *invalid += 1;
                Value::Bool(false)
            }
        },
        // Import never builds relation/formula/select columns.
        _ => {
            *invalid += 1;
            Value::Null
        }
    }
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

impl Workspace {
    /// Create a new table from a CSV file and insert all data rows.
    ///
    /// The table DDL and every INSERT run in one transaction; any error rolls
    /// the whole import back. Cells that cannot be converted to the chosen
    /// type are stored as NULL and reported in [`ImportReport::invalid_cells`].
    pub fn import_csv(&self, options: ImportCsvOptions) -> Result<ImportReport> {
        let parsed = parse_csv(&options.path)?;
        let width = parsed.width;
        if options.headers.len() != width || options.types.len() != width {
            return Err(AppError::InvalidInput(
                "表头或列类型数量与 CSV 列数不一致".into(),
            ));
        }
        for t in &options.types {
            if !matches!(
                t,
                ColumnType::Text | ColumnType::Number | ColumnType::Date | ColumnType::Checkbox
            ) {
                return Err(AppError::InvalidInput(format!(
                    "CSV 导入不支持列类型 {}",
                    t.as_str()
                )));
            }
        }

        let columns: Vec<NewColumn> = options
            .headers
            .iter()
            .zip(options.types.iter())
            .enumerate()
            .map(|(i, (name, ty))| NewColumn {
                name: name.clone(),
                // 第一列恒为标题列，必须是文本。
                col_type: if i == 0 { ColumnType::Text } else { *ty },
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
            })
            .collect();

        let data: &[Vec<String>] = if options.use_header {
            &parsed.records[1..]
        } else {
            &parsed.records
        };

        let mut invalid_cells: i64 = 0;
        let mut rows: Vec<Vec<serde_json::Value>> = Vec::with_capacity(data.len());
        for rec in data {
            let mut row = Vec::with_capacity(width);
            for (i, cell) in rec.iter().enumerate() {
                let ty = if i == 0 {
                    ColumnType::Text
                } else {
                    options.types[i]
                };
                row.push(coerce_cell(ty, cell, &mut invalid_cells));
            }
            rows.push(row);
        }

        let table_name = options.table_name.clone();
        let table = self.with_tx(|conn| {
            let table = create_table_tx(conn, &table_name, columns, None)?;
            let cols = load_columns(conn, &table.id)?;
            if cols.len() != width {
                return Err(AppError::Internal(
                    "导入建表后的列数与 CSV 列数不一致".into(),
                ));
            }
            insert_rows(conn, &table, &cols, &rows)?;
            Ok(table)
        })?;

        Ok(ImportReport {
            table,
            imported: rows.len() as i64,
            invalid_cells,
        })
    }
}

/// Bulk INSERT for freshly created, fully physical columns.
fn insert_rows(
    conn: &Connection,
    table: &TableMeta,
    cols: &[crate::schema::ColumnMeta],
    rows: &[Vec<serde_json::Value>],
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut names = vec![
        quote_ident("_rid"),
        quote_ident("_created"),
        quote_ident("_updated"),
    ];
    names.extend(
        cols.iter()
            .map(|c| quote_ident(c.sql_name().unwrap_or_default())),
    );
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_ident(&table.sql_name),
        names.join(", "),
        placeholders(cols.len() + 3)
    );
    let mut stmt = conn.prepare(&sql)?;
    for row in rows {
        let now = now_iso();
        let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(cols.len() + 3);
        params.push(rusqlite::types::Value::Text(new_id()));
        params.push(rusqlite::types::Value::Text(now.clone()));
        params.push(rusqlite::types::Value::Text(now));
        for (i, col) in cols.iter().enumerate() {
            let value = row.get(i).cloned().unwrap_or(serde_json::Value::Null);
            params.push(json_to_stored(col, &value)?.unwrap_or(rusqlite::types::Value::Null));
        }
        stmt.execute(rusqlite::params_from_iter(params.iter()))
            .map_err(map_sqlite_err)?;
    }
    Ok(())
}
