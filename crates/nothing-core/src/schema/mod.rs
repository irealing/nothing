//! Schema layer: metadata types and all table/column/view operations.
//!
//! The metadata tables (`_tables`, `_columns`, `_views`) are the source of
//! truth; physical DDL is always derived from them (which is what makes the
//! table-rebuild machinery safe).

pub mod column;
pub mod formula;
pub(crate) mod fts;
pub mod ident;
pub mod table;
pub mod view;

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use ident::{new_id, now_iso};

// ---------------------------------------------------------------------------
// Column types & options
// ---------------------------------------------------------------------------

/// User-facing column types, mapped onto real SQLite constructs:
///
/// | type          | physical                                     |
/// |---------------|----------------------------------------------|
/// | `text`        | `TEXT` (+ FTS5)                              |
/// | `number`      | `REAL`                                       |
/// | `select`      | `TEXT` + `CHECK(... IN choices)` (+ FTS5)    |
/// | `multi_select`| `TEXT` JSON array + `CHECK(json_valid(...))` |
/// | `date`        | `TEXT` ISO8601 + `CHECK(datetime(...) ...)`  |
/// | `checkbox`    | `INTEGER` + `CHECK(... IN (0,1))`            |
/// | `relation`    | junction table `r_<col>` + cascading FKs     |
/// | `formula`     | `GENERATED ALWAYS AS (...) VIRTUAL`          |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    Text,
    Number,
    Select,
    MultiSelect,
    Date,
    Checkbox,
    Relation,
    Formula,
}

impl ColumnType {
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnType::Text => "text",
            ColumnType::Number => "number",
            ColumnType::Select => "select",
            ColumnType::MultiSelect => "multi_select",
            ColumnType::Date => "date",
            ColumnType::Checkbox => "checkbox",
            ColumnType::Relation => "relation",
            ColumnType::Formula => "formula",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "text" => ColumnType::Text,
            "number" => ColumnType::Number,
            "select" => ColumnType::Select,
            "multi_select" => ColumnType::MultiSelect,
            "date" => ColumnType::Date,
            "checkbox" => ColumnType::Checkbox,
            "relation" => ColumnType::Relation,
            "formula" => ColumnType::Formula,
            other => return Err(AppError::InvalidInput(format!("未知列类型: {other}"))),
        })
    }

    /// Whether values of this type are indexed by the table's FTS5 index.
    pub fn is_searchable(self) -> bool {
        matches!(self, ColumnType::Text | ColumnType::Select)
    }
}

/// Declared result type of a formula (generated) column.
/// Presentation-only color of a column (header tint + cell background tint).
///
/// Stored as a palette **token** (never a hex value) so the light and dark
/// themes can each resolve it to their own shades.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnColor {
    Gray,
    Blue,
    Green,
    Yellow,
    Orange,
    Red,
    Purple,
    Pink,
    Brown,
}

impl ColumnColor {
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnColor::Gray => "gray",
            ColumnColor::Blue => "blue",
            ColumnColor::Green => "green",
            ColumnColor::Yellow => "yellow",
            ColumnColor::Orange => "orange",
            ColumnColor::Red => "red",
            ColumnColor::Purple => "purple",
            ColumnColor::Pink => "pink",
            ColumnColor::Brown => "brown",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "gray" => ColumnColor::Gray,
            "blue" => ColumnColor::Blue,
            "green" => ColumnColor::Green,
            "yellow" => ColumnColor::Yellow,
            "orange" => ColumnColor::Orange,
            "red" => ColumnColor::Red,
            "purple" => ColumnColor::Purple,
            "pink" => ColumnColor::Pink,
            "brown" => ColumnColor::Brown,
            other => return Err(AppError::InvalidInput(format!("未知的列颜色: {other}"))),
        })
    }
}

/// Horizontal alignment of a column's cell content.
///
/// `None` (no align stored) means "by type": numbers are right aligned, every
/// other type is left aligned. Presentation only — never part of the SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnAlign {
    Left,
    Center,
    Right,
}

impl ColumnAlign {
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnAlign::Left => "left",
            ColumnAlign::Center => "center",
            ColumnAlign::Right => "right",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "left" => ColumnAlign::Left,
            "center" => ColumnAlign::Center,
            "right" => ColumnAlign::Right,
            other => return Err(AppError::InvalidInput(format!("未知的对齐方式: {other}"))),
        })
    }
}

/// Longest accepted icon payload. Emoji can be a ZWJ sequence of a few
/// scalars, so the limit is generous but still keeps the metadata sane.
const MAX_ICON_BYTES: usize = 32;

/// Normalize an emoji icon (column or table): trim, empty → `None`, reject
/// control characters and absurdly long blobs (the UI only offers a curated
/// emoji list).
pub fn normalize_icon(raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let icon = raw.trim();
    if icon.is_empty() {
        return Ok(None);
    }
    if icon.len() > MAX_ICON_BYTES {
        return Err(AppError::InvalidInput("图标过长".into()));
    }
    if icon.chars().any(|c| c.is_control()) {
        return Err(AppError::InvalidInput("图标不能包含控制字符".into()));
    }
    Ok(Some(icon.to_string()))
}

/// Normalize a column color token; empty string clears it.
pub fn normalize_column_color(raw: Option<&str>) -> Result<Option<ColumnColor>> {
    let Some(raw) = raw else { return Ok(None) };
    let token = raw.trim();
    if token.is_empty() {
        return Ok(None);
    }
    ColumnColor::parse(token).map(Some)
}

/// Normalize an alignment token; empty string clears it ("by type").
pub fn normalize_column_align(raw: Option<&str>) -> Result<Option<ColumnAlign>> {
    let Some(raw) = raw else { return Ok(None) };
    let token = raw.trim();
    if token.is_empty() {
        return Ok(None);
    }
    ColumnAlign::parse(token).map(Some)
}

/// Reserved `kind` of the dynamic date default: evaluated when a row is
/// inserted (`now_iso()`), never stored literally.
pub const DEFAULT_NOW_KIND: &str = "now";

/// Whether a default payload is the dynamic "now" token.
pub fn is_now_default(value: &serde_json::Value) -> bool {
    value.get("kind").and_then(|v| v.as_str()) == Some(DEFAULT_NOW_KIND)
}

/// Resolve a stored column default to the value written for a new row.
///
/// Literal defaults are validated against the column type/choices; the
/// `{"kind":"now"}` token is only valid for date columns and expands to the
/// current UTC timestamp.
pub fn default_cell_value(
    col: &ColumnMeta,
    value: &serde_json::Value,
) -> Result<serde_json::Value> {
    if value.is_null() {
        return Ok(serde_json::Value::Null);
    }
    if is_now_default(value) {
        if col.is_reverse || col.col_type != ColumnType::Date {
            return Err(AppError::InvalidInput(
                "只有日期列可以使用「当前时间」默认值".into(),
            ));
        }
        return Ok(serde_json::Value::String(now_iso()));
    }
    if col.is_reverse || matches!(col.col_type, ColumnType::Formula | ColumnType::Relation) {
        return Err(AppError::InvalidInput(format!(
            "列「{}」不支持默认值",
            col.name
        )));
    }
    if matches!(col.col_type, ColumnType::Select | ColumnType::MultiSelect)
        && col.opts.select_choices()?.is_empty()
    {
        return Err(AppError::InvalidInput(format!(
            "列「{}」还没有选项，无法设置默认值",
            col.name
        )));
    }
    crate::query::json_to_stored(col, value)?;
    Ok(value.clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormulaResultType {
    Number,
    Text,
    Date,
    Checkbox,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Choice {
    /// Stable ULID of the choice (survives renames in metadata).
    pub id: String,
    /// Display name; also the value stored physically and in CHECK.
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlainOpts {}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SelectOpts {
    pub choices: Vec<Choice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelationOpts {
    /// Table id this relation points at.
    pub target_table_id: String,
    /// Restrict to a single linked row per source row.
    #[serde(default)]
    pub single: bool,
    /// Creation-only: when set, a reverse column with this name is created in
    /// the target table, sharing the same junction table (Notion-style).
    #[serde(default)]
    pub reverse_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FormulaOpts {
    /// User-facing formula expression (whitelist syntax, see [`formula`]).
    pub expr: String,
    pub result_type: FormulaResultType,
}

/// Per-type column options, stored as JSON text in `_columns.opts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColumnOpts {
    Plain(PlainOpts),
    Select(SelectOpts),
    MultiSelect(SelectOpts),
    Relation(RelationOpts),
    Formula(FormulaOpts),
}

impl ColumnOpts {
    /// Sensible default options for a column type.
    pub fn default_for(t: ColumnType) -> Self {
        match t {
            ColumnType::Select | ColumnType::MultiSelect => {
                ColumnOpts::Select(SelectOpts::default())
            }
            ColumnType::Relation => ColumnOpts::Relation(RelationOpts {
                target_table_id: String::new(),
                single: false,
                reverse_name: None,
            }),
            ColumnType::Formula => ColumnOpts::Formula(FormulaOpts {
                expr: String::new(),
                result_type: FormulaResultType::Number,
            }),
            _ => ColumnOpts::Plain(PlainOpts {}),
        }
    }

    /// Adapt options across a type change when the caller supplied none:
    /// select ↔ multi_select keep their choices, everything else resets.
    pub fn migrated(from: &ColumnOpts, to: ColumnType) -> ColumnOpts {
        let keep_choices = matches!(
            (from, to),
            (ColumnOpts::Select(_), ColumnType::Select)
                | (ColumnOpts::Select(_), ColumnType::MultiSelect)
                | (ColumnOpts::MultiSelect(_), ColumnType::Select)
                | (ColumnOpts::MultiSelect(_), ColumnType::MultiSelect)
        );
        if keep_choices {
            let choices = match from {
                ColumnOpts::Select(o) | ColumnOpts::MultiSelect(o) => o.choices.clone(),
                _ => unreachable!(),
            };
            return match to {
                ColumnType::MultiSelect => ColumnOpts::MultiSelect(SelectOpts { choices }),
                _ => ColumnOpts::Select(SelectOpts { choices }),
            };
        }
        ColumnOpts::default_for(to)
    }

    pub fn select_choices(&self) -> Result<&[Choice]> {
        match self {
            ColumnOpts::Select(o) | ColumnOpts::MultiSelect(o) => Ok(&o.choices),
            _ => Err(AppError::Internal("列选项与类型不匹配".into())),
        }
    }

    pub fn relation(&self) -> Result<&RelationOpts> {
        match self {
            ColumnOpts::Relation(o) => Ok(o),
            _ => Err(AppError::Internal("列选项与类型不匹配".into())),
        }
    }

    pub fn formula(&self) -> Result<&FormulaOpts> {
        match self {
            ColumnOpts::Formula(o) => Ok(o),
            _ => Err(AppError::Internal("列选项与类型不匹配".into())),
        }
    }
}

/// Validate that options match the column type and are internally consistent.
pub(crate) fn validate_opts(t: ColumnType, opts: &ColumnOpts) -> Result<()> {
    match (t, opts) {
        (
            ColumnType::Text | ColumnType::Number | ColumnType::Date | ColumnType::Checkbox,
            ColumnOpts::Plain(_),
        ) => Ok(()),
        (ColumnType::Select, ColumnOpts::Select(o))
        | (ColumnType::MultiSelect, ColumnOpts::MultiSelect(o)) => validate_choices(&o.choices),
        (ColumnType::Relation, ColumnOpts::Relation(o)) => {
            if o.target_table_id.is_empty() {
                return Err(AppError::InvalidInput("关联列必须指定目标表".into()));
            }
            if let Some(name) = &o.reverse_name {
                validate_user_name("反向列名", name)?;
            }
            Ok(())
        }
        (ColumnType::Formula, ColumnOpts::Formula(o)) => {
            if o.expr.trim().is_empty() {
                return Err(AppError::InvalidInput("公式不能为空".into()));
            }
            Ok(())
        }
        _ => Err(AppError::InvalidInput(format!(
            "列类型 {} 与提供的选项不匹配",
            t.as_str()
        ))),
    }
}

fn validate_choices(choices: &[Choice]) -> Result<()> {
    if choices.len() > 500 {
        return Err(AppError::InvalidInput("选项过多（最多 500）".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for c in choices {
        let name = validate_user_name("选项名", &c.name)?;
        if !seen.insert(name.clone()) {
            return Err(AppError::AlreadyExists(format!("选项 {name}")));
        }
    }
    Ok(())
}

fn validate_user_name(kind: &str, name: &str) -> Result<String> {
    ident::validate_user_name(kind, name)
}

// ---------------------------------------------------------------------------
// Metadata structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableMeta {
    pub id: String,
    pub name: String,
    pub sql_name: String,
    /// Text column used as the display name of rows (relation pickers etc.).
    pub title_col_id: Option<String>,
    pub icon: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ColumnMeta {
    pub id: String,
    pub table_id: String,
    /// User-facing name; renaming never touches the physical column (铁律 3).
    pub name: String,
    /// Physical column name `c_<id>`; unused by relation/reverse columns.
    pub sql_name: String,
    #[serde(rename = "type")]
    pub col_type: ColumnType,
    pub opts: ColumnOpts,
    pub position: i64,
    pub width: i64,
    pub visible: bool,
    /// True for the auto-created reverse side of a relation column.
    pub is_reverse: bool,
    /// For reverse columns: the id of the source relation column.
    pub reverse_of: Option<String>,
    /// Optional emoji shown before the column name in grid headers.
    pub icon: Option<String>,
    /// Optional palette token tinting the header and the column's cells.
    pub color: Option<ColumnColor>,
    /// Optional horizontal alignment; `None` means "by type".
    pub align: Option<ColumnAlign>,
    /// Value written to new rows when the cell is not supplied.
    ///
    /// Literal JSON in the cell's input shape; date columns additionally accept
    /// the `{"kind":"now"}` token (resolved on insert).
    pub default_value: Option<serde_json::Value>,
    pub created_at: String,
}

impl ColumnMeta {
    /// Whether this column is backed by a physical column in the user table.
    pub fn is_physical(&self) -> bool {
        self.col_type != ColumnType::Relation && !self.is_reverse
    }
}

/// Request to create a column (used by `create_table` and `add_column`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: ColumnType,
    #[serde(default)]
    pub opts: Option<ColumnOpts>,
    /// Emoji shown in the header; `None`/empty means "use the type icon only".
    #[serde(default)]
    pub icon: Option<String>,
    /// Palette token; `None`/empty means "no tint".
    #[serde(default)]
    pub color: Option<String>,
    /// Alignment token; `None`/empty means "by type".
    #[serde(default)]
    pub align: Option<String>,
    /// Default value written to new rows; `null` means "no default".
    #[serde(default)]
    pub default_value: Option<serde_json::Value>,
}

/// Partial update of a column. `None` fields keep their current value.
///
/// `icon`/`color`/`align` are raw strings so that an empty string clears them.
/// JSON `null` for an `Option` deserializes to `None`, so clearing a default
/// uses the explicit [`ColumnPatch::clear_default`] flag instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ColumnPatch {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub col_type: Option<ColumnType>,
    pub opts: Option<ColumnOpts>,
    pub position: Option<i64>,
    pub width: Option<i64>,
    pub visible: Option<bool>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub align: Option<String>,
    /// New default value; omitted/`null` keeps the current one.
    pub default_value: Option<serde_json::Value>,
    /// Remove the current default value.
    #[serde(default)]
    pub clear_default: bool,
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewKind {
    /// Notion-style grid: filter tree + sorts + hidden columns, compiled to
    /// parameterized SQL by the query layer (M2).
    Grid,
    /// User-written SELECT, stored as a real SQLite `CREATE VIEW v_<id>`.
    Sql,
}

impl ViewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewKind::Grid => "grid",
            ViewKind::Sql => "sql",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "grid" => ViewKind::Grid,
            "sql" => ViewKind::Sql,
            other => return Err(AppError::InvalidInput(format!("未知视图类型: {other}"))),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogicOp {
    And,
    Or,
}

/// Filter operators for grid views (compiled in M2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    IsEmpty,
    IsNotEmpty,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    NotIn,
    /// Date-specific: strictly before / after / same day as `value`.
    Before,
    After,
    On,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterRule {
    pub column_id: String,
    pub op: FilterOp,
    /// Operand; ignored by `is_empty`/`is_not_empty`.
    #[serde(default)]
    pub value: serde_json::Value,
}

/// Filter tree: either a logical group or a leaf rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterNode {
    Group {
        op: LogicOp,
        children: Vec<FilterNode>,
    },
    Rule(FilterRule),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SortSpec {
    pub column_id: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GridConfig {
    #[serde(default)]
    pub filters: Option<FilterNode>,
    #[serde(default)]
    pub sorts: Vec<SortSpec>,
    #[serde(default)]
    pub hidden_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SqlConfig {
    /// A single SELECT/WITH statement (validated, stored as `v_<view_id>`).
    pub statement: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewConfig {
    Grid(GridConfig),
    Sql(SqlConfig),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewMeta {
    pub id: String,
    /// Grid views belong to a table; SQL views are workspace-level (`None`).
    pub table_id: Option<String>,
    pub name: String,
    pub kind: ViewKind,
    pub config: ViewConfig,
    pub position: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewView {
    pub table_id: Option<String>,
    pub name: String,
    pub kind: ViewKind,
    pub config: ViewConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ViewPatch {
    pub name: Option<String>,
    pub config: Option<ViewConfig>,
    pub position: Option<i64>,
}

// ---------------------------------------------------------------------------
// Row mapping / loading helpers
// ---------------------------------------------------------------------------

pub(crate) fn table_from_row(r: &Row<'_>) -> rusqlite::Result<TableMeta> {
    Ok(TableMeta {
        id: r.get("id")?,
        name: r.get("name")?,
        sql_name: r.get("sql_name")?,
        title_col_id: r.get("title_col_id")?,
        icon: r.get("icon")?,
        position: r.get("position")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub(crate) fn column_from_row(r: &Row<'_>) -> rusqlite::Result<ColumnMeta> {
    let type_str: String = r.get("type")?;
    let opts_str: String = r.get("opts")?;
    let col_type = ColumnType::parse(&type_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let opts: ColumnOpts = serde_json::from_str(&opts_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let visible: i64 = r.get("visible")?;
    let is_reverse: i64 = r.get("is_reverse")?;
    let color_str: Option<String> = r.get("color")?;
    let color = match color_str.as_deref() {
        Some(token) => Some(ColumnColor::parse(token).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?),
        None => None,
    };
    let align_str: Option<String> = r.get("align")?;
    let align = match align_str.as_deref() {
        Some(token) => Some(ColumnAlign::parse(token).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?),
        None => None,
    };
    let default_str: Option<String> = r.get("default_value")?;
    let default_value = match default_str {
        Some(raw) => Some(serde_json::from_str(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?),
        None => None,
    };
    Ok(ColumnMeta {
        id: r.get("id")?,
        table_id: r.get("table_id")?,
        name: r.get("name")?,
        sql_name: r.get("sql_name")?,
        col_type,
        opts,
        position: r.get("position")?,
        width: r.get("width")?,
        visible: visible != 0,
        is_reverse: is_reverse != 0,
        reverse_of: r.get("reverse_of")?,
        icon: r.get("icon")?,
        color,
        align,
        default_value,
        created_at: r.get("created_at")?,
    })
}

pub(crate) fn view_from_row(r: &Row<'_>) -> rusqlite::Result<ViewMeta> {
    let kind_str: String = r.get("kind")?;
    let config_str: String = r.get("config")?;
    let kind = ViewKind::parse(&kind_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let config: ViewConfig = serde_json::from_str(&config_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(ViewMeta {
        id: r.get("id")?,
        table_id: r.get("table_id")?,
        name: r.get("name")?,
        kind,
        config,
        position: r.get("position")?,
        created_at: r.get("created_at")?,
    })
}

pub(crate) const TABLE_COLS: &str =
    r#""id","name","sql_name","title_col_id","icon","position","created_at","updated_at""#;
const COLUMN_COLS: &str = r#""id","table_id","name","sql_name","type","opts","position","width","visible","is_reverse","reverse_of","icon","color","align","default_value","created_at""#;
pub(crate) const VIEW_COLS: &str =
    r#""id","table_id","name","kind","config","position","created_at""#;

pub(crate) fn load_table(conn: &Connection, table_id: &str) -> Result<TableMeta> {
    conn.query_row(
        &format!(r#"SELECT {TABLE_COLS} FROM "_tables" WHERE "id" = ?1"#),
        [table_id],
        table_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("表 {table_id}")))
}

pub(crate) fn load_table_by_name(conn: &Connection, name: &str) -> Result<TableMeta> {
    conn.query_row(
        &format!(r#"SELECT {TABLE_COLS} FROM "_tables" WHERE "name" = ?1"#),
        [name],
        table_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("表 {name}")))
}

pub(crate) fn load_columns(conn: &Connection, table_id: &str) -> Result<Vec<ColumnMeta>> {
    let mut stmt = conn.prepare(&format!(
        r#"SELECT {COLUMN_COLS} FROM "_columns" WHERE "table_id" = ?1 ORDER BY "position", "created_at""#
    ))?;
    let rows = stmt.query_map([table_id], column_from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub(crate) fn load_column(conn: &Connection, table_id: &str, col_id: &str) -> Result<ColumnMeta> {
    conn.query_row(
        &format!(r#"SELECT {COLUMN_COLS} FROM "_columns" WHERE "table_id" = ?1 AND "id" = ?2"#),
        rusqlite::params![table_id, col_id],
        column_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("列 {col_id}")))
}

pub(crate) fn load_view(conn: &Connection, view_id: &str) -> Result<ViewMeta> {
    conn.query_row(
        &format!(r#"SELECT {VIEW_COLS} FROM "_views" WHERE "id" = ?1"#),
        [view_id],
        view_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("视图 {view_id}")))
}

/// Insert a `_columns` row from a fully-populated [`ColumnMeta`].
pub(crate) fn insert_column(conn: &Connection, c: &ColumnMeta) -> Result<()> {
    conn.execute(
        &format!(
            r#"INSERT INTO "_columns" ({COLUMN_COLS})
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)"#
        ),
        rusqlite::params![
            c.id,
            c.table_id,
            c.name,
            c.sql_name,
            c.col_type.as_str(),
            serde_json::to_string(&c.opts)?,
            c.position,
            c.width,
            c.visible as i64,
            c.is_reverse as i64,
            c.reverse_of,
            c.icon,
            c.color.map(|c| c.as_str()),
            c.align.map(|a| a.as_str()),
            c.default_value
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            c.created_at,
        ],
    )?;
    Ok(())
}

/// Next free position at the end of a table's column list.
pub(crate) fn next_position(conn: &Connection, table_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        r#"SELECT COALESCE(MAX("position"), -1) + 1 FROM "_columns" WHERE "table_id" = ?1"#,
        [table_id],
        |r| r.get(0),
    )?)
}

pub(crate) fn touch_table(conn: &Connection, table_id: &str) -> Result<()> {
    conn.execute(
        r#"UPDATE "_tables" SET "updated_at" = ?1 WHERE "id" = ?2"#,
        rusqlite::params![now_iso(), table_id],
    )?;
    Ok(())
}

/// Build a [`ColumnMeta`] for a new column (id, physical name, timestamp).
pub(crate) fn build_column_meta(
    table_id: &str,
    new: &NewColumn,
    position: i64,
) -> Result<ColumnMeta> {
    let name = ident::validate_user_name("列名", &new.name)?;
    let opts = new
        .opts
        .clone()
        .unwrap_or_else(|| ColumnOpts::default_for(new.col_type));
    validate_opts(new.col_type, &opts)?;
    let icon = normalize_icon(new.icon.as_deref())?;
    let color = normalize_column_color(new.color.as_deref())?;
    let align = normalize_column_align(new.align.as_deref())?;
    let default_value = new.default_value.as_ref().filter(|v| !v.is_null()).cloned();
    let id = new_id();
    Ok(ColumnMeta {
        id: id.clone(),
        table_id: table_id.to_string(),
        name,
        sql_name: ident::column_sql_name(&id),
        col_type: new.col_type,
        opts,
        position,
        width: 160,
        visible: true,
        is_reverse: false,
        reverse_of: None,
        icon,
        color,
        align,
        default_value,
        created_at: now_iso(),
    })
}
