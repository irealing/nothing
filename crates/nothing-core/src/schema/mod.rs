//! Schema layer: the polymorphic metadata object model and all table/column/
//! view operations.
//!
//! Storage is a **single** `_meta` node table (`kind` discriminator, self
//! referencing `parent_id`). SQL is only a typed store + safety net; the Rust
//! object model below owns the invariants (parent kinds, type/field pairing,
//! reverse-column lifetime) and the business logic never deals with nullable
//! row fields.
//!
//! Logical tree:
//!
//! ```text
//! table
//! ├── column ── option (select / multi_select choices)
//! └── view ──── view_column (the view's own column node: width/order/hidden)
//! ```
//!
//! A relation column is a graph edge, not containment: `target_table_id`
//! points at the target table and a reverse column (`origin_id`) lives under
//! the target table but dies with its origin. Both are real foreign keys with
//! `ON DELETE CASCADE`.

pub mod column;
pub mod formula;
pub(crate) mod fts;
pub mod ident;
pub mod table;
pub mod view;

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use ident::{new_id, now_iso};

// ---------------------------------------------------------------------------
// Column types & presentation
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

/// Presentation-only color of a column (header tint + cell background tint).
///
/// Either one of the curated palette **tokens** (so the light and dark themes
/// can each resolve it to their own shades) or a user-picked `#rrggbb` value.
/// Custom colors are still presentation data, never part of the SQL.
#[derive(Debug, Clone, PartialEq, Eq)]
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
    Amber,
    Lime,
    Teal,
    Cyan,
    Sky,
    Indigo,
    Violet,
    Plum,
    Crimson,
    /// User-picked color, stored normalized as `#rrggbb` (lowercase, expanded).
    Custom(String),
}

/// Every preset token, in picker order.
pub const COLUMN_COLOR_TOKENS: [&str; 18] = [
    "gray", "brown", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "sky", "blue",
    "indigo", "violet", "purple", "plum", "pink", "crimson", "red",
];

impl ColumnColor {
    pub fn as_str(&self) -> &str {
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
            ColumnColor::Amber => "amber",
            ColumnColor::Lime => "lime",
            ColumnColor::Teal => "teal",
            ColumnColor::Cyan => "cyan",
            ColumnColor::Sky => "sky",
            ColumnColor::Indigo => "indigo",
            ColumnColor::Violet => "violet",
            ColumnColor::Plum => "plum",
            ColumnColor::Crimson => "crimson",
            ColumnColor::Custom(hex) => hex,
        }
    }

    /// Strict parse used when writing: unknown tokens and malformed hex are
    /// rejected so a typo never reaches `_meta`.
    pub fn parse(s: &str) -> Result<Self> {
        if let Some(color) = Self::parse_preset(s) {
            return Ok(color);
        }
        match normalize_hex(s) {
            Some(hex) => Ok(ColumnColor::Custom(hex)),
            None => Err(AppError::InvalidInput(format!("未知的列颜色: {s}"))),
        }
    }

    /// Lenient parse used when reading: presentation values written by a newer
    /// version degrade to "no color" instead of failing the whole table load.
    pub fn parse_lenient(s: &str) -> Option<Self> {
        Self::parse_preset(s).or_else(|| normalize_hex(s).map(ColumnColor::Custom))
    }

    fn parse_preset(s: &str) -> Option<Self> {
        Some(match s {
            "gray" => ColumnColor::Gray,
            "blue" => ColumnColor::Blue,
            "green" => ColumnColor::Green,
            "yellow" => ColumnColor::Yellow,
            "orange" => ColumnColor::Orange,
            "red" => ColumnColor::Red,
            "purple" => ColumnColor::Purple,
            "pink" => ColumnColor::Pink,
            "brown" => ColumnColor::Brown,
            "amber" => ColumnColor::Amber,
            "lime" => ColumnColor::Lime,
            "teal" => ColumnColor::Teal,
            "cyan" => ColumnColor::Cyan,
            "sky" => ColumnColor::Sky,
            "indigo" => ColumnColor::Indigo,
            "violet" => ColumnColor::Violet,
            "plum" => ColumnColor::Plum,
            "crimson" => ColumnColor::Crimson,
            _ => return None,
        })
    }
}

impl Serialize for ColumnColor {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ColumnColor {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        ColumnColor::parse(&raw).map_err(serde::de::Error::custom)
    }
}

/// Normalize a `#rgb` / `#rrggbb` string to lowercase `#rrggbb`.
fn normalize_hex(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix('#')?;
    if !rest.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match rest.len() {
        3 => {
            let mut hex = String::with_capacity(7);
            hex.push('#');
            for c in rest.chars() {
                hex.push(c.to_ascii_lowercase());
                hex.push(c.to_ascii_lowercase());
            }
            Some(hex)
        }
        6 => Some(format!("#{}", rest.to_ascii_lowercase())),
        _ => None,
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

/// Presentation-only number style. Never part of the SQL: the stored value
/// stays a plain REAL; the frontend renders it through `Intl.NumberFormat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NumberStyle {
    #[default]
    Plain,
    Currency,
    Percent,
}

/// ISO-4217 currency token used by [`NumberStyle::Currency`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Currency {
    Cny,
    Usd,
    Eur,
    Gbp,
    Jpy,
}

/// Presentation-only date display style. Storage is always ISO8601.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateStyle {
    /// Localized calendar date, no time component.
    #[default]
    Date,
    /// Localized date plus hours/minutes.
    DateTime,
    /// The raw stored ISO8601 string.
    Iso,
}

fn default_decimals() -> u8 {
    2
}

fn default_true() -> bool {
    true
}

/// Cell display format for number/date columns (and formula columns whose
/// result type is number/date). Stored as JSON in `_meta.format`; validated on
/// write and applied only by the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColumnFormat {
    Number {
        #[serde(default)]
        style: NumberStyle,
        #[serde(default)]
        currency: Option<Currency>,
        #[serde(default = "default_decimals")]
        decimals: u8,
        #[serde(default = "default_true")]
        thousands: bool,
    },
    Date {
        #[serde(default)]
        style: DateStyle,
    },
}

impl ColumnFormat {
    /// Whether this format can be applied to a column of `col_type`.
    pub fn allows(&self, col_type: ColumnType) -> bool {
        matches!(
            (self, col_type),
            (ColumnFormat::Number { .. }, ColumnType::Number)
                | (ColumnFormat::Date { .. }, ColumnType::Date)
        )
    }

    /// Strict validation for user writes.
    pub fn validate(&self, col_type: ColumnType) -> Result<()> {
        if !self.allows(col_type) {
            return Err(AppError::InvalidInput(
                "数字格式只能用于数字列，日期格式只能用于日期列".into(),
            ));
        }
        if let ColumnFormat::Number {
            style,
            currency,
            decimals,
            ..
        } = self
        {
            if *decimals > 6 {
                return Err(AppError::InvalidInput("小数位必须在 0 到 6 之间".into()));
            }
            if *style == NumberStyle::Currency && currency.is_none() {
                return Err(AppError::InvalidInput("货币格式必须指定币种".into()));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormulaResultType {
    Number,
    Text,
    Date,
    Checkbox,
}

impl FormulaResultType {
    pub fn as_str(self) -> &'static str {
        match self {
            FormulaResultType::Number => "number",
            FormulaResultType::Text => "text",
            FormulaResultType::Date => "date",
            FormulaResultType::Checkbox => "checkbox",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "number" => FormulaResultType::Number,
            "text" => FormulaResultType::Text,
            "date" => FormulaResultType::Date,
            "checkbox" => FormulaResultType::Checkbox,
            other => {
                return Err(AppError::InvalidInput(format!(
                    "未知的公式结果类型: {other}"
                )))
            }
        })
    }

    /// The physical column type a formula result behaves like.
    pub fn as_column_type(self) -> ColumnType {
        match self {
            FormulaResultType::Number => ColumnType::Number,
            FormulaResultType::Text => ColumnType::Text,
            FormulaResultType::Date => ColumnType::Date,
            FormulaResultType::Checkbox => ColumnType::Checkbox,
        }
    }
}

/// Longest accepted icon payload. Emoji can be a ZWJ sequence of a few
/// scalars, so the limit is generous but still keeps the metadata sane.
const MAX_ICON_BYTES: usize = 32;

/// Normalize an emoji icon (column, table, view or option): trim, empty →
/// `None`, reject control characters and absurdly long blobs (the UI only
/// offers a curated emoji list).
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

/// Normalize a color token; empty string clears it.
pub fn normalize_color(raw: Option<&str>) -> Result<Option<ColumnColor>> {
    let Some(raw) = raw else { return Ok(None) };
    let token = raw.trim();
    if token.is_empty() {
        return Ok(None);
    }
    ColumnColor::parse(token).map(Some)
}

/// Backwards-compatible alias used by column code.
pub fn normalize_column_color(raw: Option<&str>) -> Result<Option<ColumnColor>> {
    normalize_color(raw)
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
        if col.is_reverse() || col.col_type() != ColumnType::Date {
            return Err(AppError::InvalidInput(
                "只有日期列可以使用「当前时间」默认值".into(),
            ));
        }
        return Ok(serde_json::Value::String(now_iso()));
    }
    if col.is_reverse() || matches!(col.col_type(), ColumnType::Formula | ColumnType::Relation) {
        return Err(AppError::InvalidInput(format!(
            "列「{}」不支持默认值",
            col.name
        )));
    }
    if matches!(col.col_type(), ColumnType::Select | ColumnType::MultiSelect)
        && col.choices().is_empty()
    {
        return Err(AppError::InvalidInput(format!(
            "列「{}」还没有选项，无法设置默认值",
            col.name
        )));
    }
    crate::query::json_to_stored(col, value)?;
    Ok(value.clone())
}

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

/// A select / multi-select choice. Choices are real nodes (`kind='option'`),
/// not a JSON array, so they can carry a stable id, order, icon and color.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OptionMeta {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<ColumnColor>,
    pub position: i64,
}

/// Reference data of a relation column (a graph edge between two tables).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelationData {
    /// Table this relation points at.
    pub target_table_id: String,
    /// Restrict to a single linked row per source row.
    pub single: bool,
    /// For reverse columns: the source relation column this is the other side
    /// of. `None` for a source relation column.
    pub origin_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FormulaData {
    /// Physical generated-column name.
    pub sql_name: String,
    /// User-facing formula expression (whitelist syntax, see [`formula`]).
    pub expr: String,
    pub result_type: FormulaResultType,
}

/// Polymorphic payload of a column. The variant *is* the column type; there is
/// no separate nullable field soup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColumnData {
    Text {
        sql_name: String,
    },
    Number {
        sql_name: String,
    },
    Date {
        sql_name: String,
    },
    Checkbox {
        sql_name: String,
    },
    Select {
        sql_name: String,
        choices: Vec<OptionMeta>,
    },
    MultiSelect {
        sql_name: String,
        choices: Vec<OptionMeta>,
    },
    Relation(RelationData),
    Formula(FormulaData),
}

impl ColumnData {
    pub fn col_type(&self) -> ColumnType {
        match self {
            ColumnData::Text { .. } => ColumnType::Text,
            ColumnData::Number { .. } => ColumnType::Number,
            ColumnData::Date { .. } => ColumnType::Date,
            ColumnData::Checkbox { .. } => ColumnType::Checkbox,
            ColumnData::Select { .. } => ColumnType::Select,
            ColumnData::MultiSelect { .. } => ColumnType::MultiSelect,
            ColumnData::Relation(_) => ColumnType::Relation,
            ColumnData::Formula(_) => ColumnType::Formula,
        }
    }

    /// Physical column name; `None` for relations (data lives in a junction).
    pub fn sql_name(&self) -> Option<&str> {
        match self {
            ColumnData::Text { sql_name }
            | ColumnData::Number { sql_name }
            | ColumnData::Date { sql_name }
            | ColumnData::Checkbox { sql_name }
            | ColumnData::Select { sql_name, .. }
            | ColumnData::MultiSelect { sql_name, .. } => Some(sql_name),
            ColumnData::Formula(f) => Some(&f.sql_name),
            ColumnData::Relation(_) => None,
        }
    }

    /// Value semantics: a formula behaves like its declared result type.
    pub fn effective_type(&self) -> ColumnType {
        match self {
            ColumnData::Formula(f) => f.result_type.as_column_type(),
            other => other.col_type(),
        }
    }

    pub fn is_physical(&self) -> bool {
        !matches!(self, ColumnData::Relation(_))
    }

    pub fn choices(&self) -> &[OptionMeta] {
        match self {
            ColumnData::Select { choices, .. } | ColumnData::MultiSelect { choices, .. } => choices,
            _ => &[],
        }
    }

    pub fn relation(&self) -> Option<&RelationData> {
        match self {
            ColumnData::Relation(r) => Some(r),
            _ => None,
        }
    }

    pub fn formula(&self) -> Option<&FormulaData> {
        match self {
            ColumnData::Formula(f) => Some(f),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableMeta {
    pub id: String,
    pub name: String,
    pub sql_name: String,
    /// Text column used as the display name of rows (relation pickers etc.).
    pub title_col_id: Option<String>,
    pub icon: Option<String>,
    pub color: Option<ColumnColor>,
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
    pub position: i64,
    /// Default width; the effective width of a column in a view comes from the
    /// view's own `ViewColumnMeta`.
    pub width: i64,
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
    /// Presentation-only number/date format; `None` renders the raw value.
    pub format: Option<ColumnFormat>,
    pub created_at: String,
    /// Polymorphic type-specific payload.
    pub data: ColumnData,
}

impl ColumnMeta {
    pub fn col_type(&self) -> ColumnType {
        self.data.col_type()
    }

    pub fn sql_name(&self) -> Option<&str> {
        self.data.sql_name()
    }

    /// Whether this column is backed by a physical column in the user table.
    pub fn is_physical(&self) -> bool {
        self.data.is_physical()
    }

    /// True for the auto-created reverse side of a relation column.
    pub fn is_reverse(&self) -> bool {
        self.data.relation().is_some_and(|r| r.origin_id.is_some())
    }

    /// For reverse columns: the id of the source relation column.
    pub fn origin_id(&self) -> Option<&str> {
        self.data.relation().and_then(|r| r.origin_id.as_deref())
    }

    pub fn relation(&self) -> Option<&RelationData> {
        self.data.relation()
    }

    pub fn formula(&self) -> Option<&FormulaData> {
        self.data.formula()
    }

    pub fn choices(&self) -> &[OptionMeta] {
        self.data.choices()
    }

    /// The type whose value semantics a column's stored values follow.
    pub fn effective_type(&self) -> ColumnType {
        self.data.effective_type()
    }
}

// ---------------------------------------------------------------------------
// Creation / patch inputs (flat DTOs from the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewChoice {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    /// Emoji icon; empty/whitespace clears it (full replacement semantics).
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// Request to create a column (used by `create_table` and `add_column`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: ColumnType,
    #[serde(default)]
    pub choices: Vec<NewChoice>,
    #[serde(default)]
    pub target_table_id: Option<String>,
    #[serde(default)]
    pub single: bool,
    /// Creation-only: when set, a reverse column with this name is created in
    /// the target table, sharing the same junction table (Notion-style).
    #[serde(default)]
    pub reverse_name: Option<String>,
    #[serde(default)]
    pub formula_expr: Option<String>,
    #[serde(default)]
    pub formula_result_type: Option<FormulaResultType>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub default_value: Option<serde_json::Value>,
    /// Presentation-only number/date format; omitted/`null` keeps the raw value.
    #[serde(default)]
    pub format: Option<ColumnFormat>,
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
    pub choices: Option<Vec<NewChoice>>,
    pub target_table_id: Option<String>,
    pub single: Option<bool>,
    pub formula_expr: Option<String>,
    pub formula_result_type: Option<FormulaResultType>,
    pub position: Option<i64>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub align: Option<String>,
    /// New default value; omitted/`null` keeps the current one.
    pub default_value: Option<serde_json::Value>,
    /// Remove the current default value.
    #[serde(default)]
    pub clear_default: bool,
    /// New presentation format; omitted/`null` keeps the current one.
    pub format: Option<ColumnFormat>,
    /// Remove the current presentation format.
    #[serde(default)]
    pub clear_format: bool,
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewKind {
    /// Notion-style grid: filter tree + sorts + its own column nodes, compiled
    /// to parameterized SQL by the query layer.
    Grid,
    /// User-written SELECT, stored as metadata and executed read-only.
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

/// Filter operators for grid views.
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SqlConfig {
    /// A single SELECT/WITH statement (validated, stored as metadata).
    pub statement: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewData {
    Grid(GridConfig),
    Sql(SqlConfig),
}

/// A grid view's own column node. Width/order/hidden live here, so the same
/// base column can differ from view to view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewColumnMeta {
    pub id: String,
    pub column_id: String,
    pub position: i64,
    pub width: i64,
    pub hidden: bool,
    /// Part of this view's frozen left prefix (v5).
    pub frozen: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewMeta {
    pub id: String,
    /// Grid views belong to a table; SQL views are workspace-level (`None`).
    pub table_id: Option<String>,
    pub name: String,
    pub kind: ViewKind,
    pub icon: Option<String>,
    pub color: Option<ColorAlias>,
    pub position: i64,
    pub created_at: String,
    pub data: ViewData,
    /// The view's own column nodes (grid views only; empty for SQL views).
    pub columns: Vec<ViewColumnMeta>,
}

/// `ViewMeta.color` is the same palette token as columns; keep the alias so
/// the shared type stays obvious in the public API.
pub type ColorAlias = ColumnColor;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewView {
    pub table_id: Option<String>,
    pub name: String,
    pub kind: ViewKind,
    pub data: ViewData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ViewColumnPatch {
    /// Required by `ViewPatch.columns`; omitted by the single-column command
    /// (which carries the id as a separate argument).
    #[serde(default)]
    pub column_id: String,
    pub position: Option<i64>,
    pub width: Option<i64>,
    pub hidden: Option<bool>,
    pub frozen: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ViewPatch {
    pub name: Option<String>,
    pub data: Option<ViewData>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub position: Option<i64>,
    /// View-column overrides applied in the same transaction.
    #[serde(default)]
    pub columns: Option<Vec<ViewColumnPatch>>,
}

// ---------------------------------------------------------------------------
// Raw row mapping
// ---------------------------------------------------------------------------

pub(crate) const META_COLS: &str = r#""id","parent_id","kind","name","position","icon","color","width","created_at","updated_at","sql_name","title_col_id","col_type","align","default_value","target_table_id","single","origin_id","formula_expr","formula_result_type","view_kind","filters","sorts","statement","ref_id","hidden","frozen","format""#;

#[derive(Debug, Clone)]
pub(crate) struct RawMeta {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub name: Option<String>,
    pub position: i64,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub width: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub sql_name: Option<String>,
    pub title_col_id: Option<String>,
    pub col_type: Option<String>,
    pub align: Option<String>,
    pub default_value: Option<String>,
    pub target_table_id: Option<String>,
    pub single: Option<i64>,
    pub origin_id: Option<String>,
    pub formula_expr: Option<String>,
    pub formula_result_type: Option<String>,
    pub view_kind: Option<String>,
    pub filters: Option<String>,
    pub sorts: Option<String>,
    pub statement: Option<String>,
    pub ref_id: Option<String>,
    pub hidden: Option<i64>,
    pub frozen: Option<i64>,
    pub format: Option<String>,
}

pub(crate) fn raw_from_row(r: &Row<'_>) -> rusqlite::Result<RawMeta> {
    Ok(RawMeta {
        id: r.get("id")?,
        parent_id: r.get("parent_id")?,
        kind: r.get("kind")?,
        name: r.get("name")?,
        position: r.get("position")?,
        icon: r.get("icon")?,
        color: r.get("color")?,
        width: r.get("width")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        sql_name: r.get("sql_name")?,
        title_col_id: r.get("title_col_id")?,
        col_type: r.get("col_type")?,
        align: r.get("align")?,
        default_value: r.get("default_value")?,
        target_table_id: r.get("target_table_id")?,
        single: r.get("single")?,
        origin_id: r.get("origin_id")?,
        formula_expr: r.get("formula_expr")?,
        formula_result_type: r.get("formula_result_type")?,
        view_kind: r.get("view_kind")?,
        filters: r.get("filters")?,
        sorts: r.get("sorts")?,
        statement: r.get("statement")?,
        ref_id: r.get("ref_id")?,
        hidden: r.get("hidden")?,
        frozen: r.get("frozen")?,
        format: r.get("format")?,
    })
}

fn parse_color(raw: Option<&str>) -> rusqlite::Result<Option<ColumnColor>> {
    // Lenient on read: a value written by a newer build (unknown token or a
    // custom color we cannot parse) only loses its tint, never the table.
    Ok(raw.and_then(ColumnColor::parse_lenient))
}

fn parse_align(raw: Option<&str>) -> rusqlite::Result<Option<ColumnAlign>> {
    match raw {
        None => Ok(None),
        Some(token) => ColumnAlign::parse(token).map(Some).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        }),
    }
}

fn internal(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(AppError::Internal(msg.into())),
    )
}

pub(crate) fn table_from_raw(r: RawMeta) -> rusqlite::Result<TableMeta> {
    if r.kind != "table" {
        return Err(internal("节点不是表"));
    }
    Ok(TableMeta {
        id: r.id,
        name: r.name.ok_or_else(|| internal("表缺少名称"))?,
        sql_name: r.sql_name.ok_or_else(|| internal("表缺少物理名"))?,
        title_col_id: r.title_col_id,
        icon: r.icon,
        color: parse_color(r.color.as_deref())?,
        position: r.position,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}

pub(crate) fn option_from_raw(r: RawMeta) -> rusqlite::Result<OptionMeta> {
    Ok(OptionMeta {
        id: r.id,
        name: r.name.ok_or_else(|| internal("选项缺少名称"))?,
        icon: r.icon,
        color: parse_color(r.color.as_deref())?,
        position: r.position,
    })
}

pub(crate) fn column_from_raw(
    r: RawMeta,
    choices: Vec<OptionMeta>,
) -> rusqlite::Result<ColumnMeta> {
    if r.kind != "column" {
        return Err(internal("节点不是列"));
    }
    let type_str = r.col_type.clone().ok_or_else(|| internal("列缺少类型"))?;
    let col_type = ColumnType::parse(&type_str).map_err(|e| internal(e.to_string()))?;
    let sql_name = r.sql_name.clone();
    let require_sql = || sql_name.clone().ok_or_else(|| internal("物理列缺少物理名"));
    let data = match col_type {
        ColumnType::Text => ColumnData::Text {
            sql_name: require_sql()?,
        },
        ColumnType::Number => ColumnData::Number {
            sql_name: require_sql()?,
        },
        ColumnType::Date => ColumnData::Date {
            sql_name: require_sql()?,
        },
        ColumnType::Checkbox => ColumnData::Checkbox {
            sql_name: require_sql()?,
        },
        ColumnType::Select => ColumnData::Select {
            sql_name: require_sql()?,
            choices,
        },
        ColumnType::MultiSelect => ColumnData::MultiSelect {
            sql_name: require_sql()?,
            choices,
        },
        ColumnType::Relation => ColumnData::Relation(RelationData {
            target_table_id: r
                .target_table_id
                .ok_or_else(|| internal("关联列缺少目标表"))?,
            single: r.single.unwrap_or(0) != 0,
            origin_id: r.origin_id,
        }),
        ColumnType::Formula => {
            let result_type = r
                .formula_result_type
                .as_deref()
                .ok_or_else(|| internal("公式列缺少结果类型"))?;
            let result_type =
                FormulaResultType::parse(result_type).map_err(|e| internal(e.to_string()))?;
            ColumnData::Formula(FormulaData {
                sql_name: require_sql()?,
                expr: r.formula_expr.ok_or_else(|| internal("公式列缺少表达式"))?,
                result_type,
            })
        }
    };
    let default_value = match r.default_value {
        Some(raw) => Some(serde_json::from_str(&raw).map_err(|e| internal(e.to_string()))?),
        None => None,
    };
    // Lenient on read: a format from a newer build that no longer matches the
    // column's effective type simply loses its formatting.
    let format = r
        .format
        .as_deref()
        .filter(|raw| !raw.trim().is_empty())
        .and_then(|raw| serde_json::from_str::<ColumnFormat>(raw).ok())
        .filter(|f| f.allows(data.effective_type()));
    Ok(ColumnMeta {
        id: r.id,
        table_id: r.parent_id.ok_or_else(|| internal("列缺少所属表"))?,
        name: r.name.ok_or_else(|| internal("列缺少名称"))?,
        position: r.position,
        width: r.width.unwrap_or(160),
        icon: r.icon,
        color: parse_color(r.color.as_deref())?,
        align: parse_align(r.align.as_deref())?,
        default_value,
        format,
        created_at: r.created_at,
        data,
    })
}

pub(crate) fn view_column_from_raw(r: RawMeta) -> rusqlite::Result<ViewColumnMeta> {
    Ok(ViewColumnMeta {
        id: r.id,
        column_id: r.ref_id.ok_or_else(|| internal("视图列缺少基列"))?,
        position: r.position,
        width: r.width.unwrap_or(160),
        hidden: r.hidden.unwrap_or(0) != 0,
        frozen: r.frozen.unwrap_or(0) != 0,
    })
}

pub(crate) fn view_from_raw(
    r: RawMeta,
    columns: Vec<ViewColumnMeta>,
) -> rusqlite::Result<ViewMeta> {
    if r.kind != "view" {
        return Err(internal("节点不是视图"));
    }
    let kind_str = r
        .view_kind
        .clone()
        .ok_or_else(|| internal("视图缺少类型"))?;
    let kind = ViewKind::parse(&kind_str).map_err(|e| internal(e.to_string()))?;
    let data = match kind {
        ViewKind::Grid => {
            let filters = match r.filters.as_deref() {
                Some(raw) => serde_json::from_str(raw).map_err(|e| internal(e.to_string()))?,
                None => None,
            };
            let sorts = match r.sorts.as_deref() {
                Some(raw) => serde_json::from_str(raw).map_err(|e| internal(e.to_string()))?,
                None => Vec::new(),
            };
            ViewData::Grid(GridConfig { filters, sorts })
        }
        ViewKind::Sql => ViewData::Sql(SqlConfig {
            statement: r.statement.ok_or_else(|| internal("SQL 视图缺少语句"))?,
        }),
    };
    Ok(ViewMeta {
        id: r.id,
        table_id: r.parent_id,
        name: r.name.ok_or_else(|| internal("视图缺少名称"))?,
        kind,
        icon: r.icon,
        color: parse_color(r.color.as_deref())?,
        position: r.position,
        created_at: r.created_at,
        data,
        columns,
    })
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

pub(crate) fn load_table(conn: &Connection, table_id: &str) -> Result<TableMeta> {
    let raw: RawMeta = conn
        .query_row(
            &format!(r#"SELECT {META_COLS} FROM "_meta" WHERE "id" = ?1 AND "kind" = 'table'"#),
            [table_id],
            raw_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("表 {table_id}")))?;
    Ok(table_from_raw(raw)?)
}

fn load_options(conn: &Connection, column_id: &str) -> Result<Vec<OptionMeta>> {
    let mut stmt = conn.prepare(&format!(
        r#"SELECT {META_COLS} FROM "_meta"
           WHERE "parent_id" = ?1 AND "kind" = 'option'
           ORDER BY "position", "created_at""#
    ))?;
    let rows = stmt.query_map([column_id], |r| raw_from_row(r).and_then(option_from_raw))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub(crate) fn load_columns(conn: &Connection, table_id: &str) -> Result<Vec<ColumnMeta>> {
    let mut stmt = conn.prepare(&format!(
        r#"SELECT {META_COLS} FROM "_meta"
           WHERE "parent_id" = ?1 AND "kind" = 'column'
           ORDER BY "position", "created_at""#
    ))?;
    let raws = stmt
        .query_map([table_id], raw_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    // Load every choice for the table's columns in one query (防 N+1).
    let mut choices: HashMap<String, Vec<OptionMeta>> = HashMap::new();
    let mut stmt = conn.prepare(&format!(
        r#"SELECT {META_COLS} FROM "_meta"
           WHERE "kind" = 'option'
             AND "parent_id" IN (SELECT "id" FROM "_meta"
                                 WHERE "kind" = 'column' AND "parent_id" = ?1)
           ORDER BY "parent_id", "position", "created_at""#
    ))?;
    let rows = stmt.query_map([table_id], raw_from_row)?;
    for row in rows {
        let raw = row?;
        let parent = raw
            .parent_id
            .clone()
            .ok_or_else(|| AppError::Internal("选项缺少所属列".into()))?;
        choices
            .entry(parent)
            .or_default()
            .push(option_from_raw(raw)?);
    }
    drop(stmt);

    let mut out = Vec::with_capacity(raws.len());
    for raw in raws {
        let opts = choices.remove(&raw.id).unwrap_or_default();
        out.push(column_from_raw(raw, opts)?);
    }
    Ok(out)
}

pub(crate) fn load_column(conn: &Connection, table_id: &str, col_id: &str) -> Result<ColumnMeta> {
    let raw: RawMeta = conn
        .query_row(
            &format!(
                r#"SELECT {META_COLS} FROM "_meta"
                   WHERE "id" = ?1 AND "kind" = 'column' AND "parent_id" = ?2"#
            ),
            rusqlite::params![col_id, table_id],
            raw_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("列 {col_id}")))?;
    let options = load_options(conn, col_id)?;
    Ok(column_from_raw(raw, options)?)
}

pub(crate) fn load_view_columns(conn: &Connection, view_id: &str) -> Result<Vec<ViewColumnMeta>> {
    let mut stmt = conn.prepare(&format!(
        r#"SELECT {META_COLS} FROM "_meta"
           WHERE "parent_id" = ?1 AND "kind" = 'view_column'
           ORDER BY "position", "created_at""#
    ))?;
    let rows = stmt.query_map([view_id], |r| {
        raw_from_row(r).and_then(view_column_from_raw)
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub(crate) fn load_view(conn: &Connection, view_id: &str) -> Result<ViewMeta> {
    let raw: RawMeta = conn
        .query_row(
            &format!(r#"SELECT {META_COLS} FROM "_meta" WHERE "id" = ?1 AND "kind" = 'view'"#),
            [view_id],
            raw_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("视图 {view_id}")))?;
    let columns = load_view_columns(conn, view_id)?;
    Ok(view_from_raw(raw, columns)?)
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_node(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
    kind: &str,
    name: Option<&str>,
    position: i64,
    icon: Option<&str>,
    color: Option<&str>,
    width: Option<i64>,
    sql_name: Option<&str>,
    title_col_id: Option<&str>,
    col_type: Option<&str>,
    align: Option<&str>,
    default_value: Option<&str>,
    target_table_id: Option<&str>,
    single: Option<bool>,
    origin_id: Option<&str>,
    formula_expr: Option<&str>,
    formula_result_type: Option<&str>,
    view_kind: Option<&str>,
    filters: Option<&str>,
    sorts: Option<&str>,
    statement: Option<&str>,
    ref_id: Option<&str>,
    hidden: Option<bool>,
) -> Result<()> {
    let now = now_iso();
    conn.execute(
        r#"INSERT INTO "_meta" (
             "id","parent_id","kind","name","position","icon","color","width",
             "created_at","updated_at","sql_name","title_col_id","col_type",
             "align","default_value","target_table_id","single","origin_id",
             "formula_expr","formula_result_type","view_kind","filters","sorts",
             "statement","ref_id","hidden")
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10,?11,?12,?13,?14,?15,
                   ?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)"#,
        rusqlite::params![
            id,
            parent_id,
            kind,
            name,
            position,
            icon,
            color,
            width,
            now,
            sql_name,
            title_col_id,
            col_type,
            align,
            default_value,
            target_table_id,
            single.map(|b| b as i64),
            origin_id,
            formula_expr,
            formula_result_type,
            view_kind,
            filters,
            sorts,
            statement,
            ref_id,
            hidden.map(|b| b as i64),
        ],
    )?;
    Ok(())
}

pub(crate) fn insert_table_node(conn: &Connection, t: &TableMeta) -> Result<()> {
    insert_node(
        conn,
        &t.id,
        None,
        "table",
        Some(&t.name),
        t.position,
        t.icon.as_deref(),
        t.color.as_ref().map(|c| c.as_str()),
        None,
        Some(&t.sql_name),
        t.title_col_id.as_deref(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
}

pub(crate) fn insert_column_node(conn: &Connection, c: &ColumnMeta) -> Result<()> {
    let (col_type, target, single, origin, formula_expr, result_type) = match &c.data {
        ColumnData::Relation(r) => (
            "relation",
            Some(r.target_table_id.as_str()),
            Some(r.single),
            r.origin_id.as_deref(),
            None,
            None,
        ),
        ColumnData::Formula(f) => (
            "formula",
            None,
            None,
            None,
            Some(f.expr.as_str()),
            Some(f.result_type.as_str()),
        ),
        other => (other.col_type().as_str(), None, None, None, None, None),
    };
    insert_node(
        conn,
        &c.id,
        Some(&c.table_id),
        "column",
        Some(&c.name),
        c.position,
        c.icon.as_deref(),
        c.color.as_ref().map(|c| c.as_str()),
        Some(c.width),
        c.sql_name(),
        None,
        Some(col_type),
        c.align.map(|a| a.as_str()),
        c.default_value
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .as_deref(),
        target,
        single,
        origin,
        formula_expr,
        result_type,
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    if let Some(format) = &c.format {
        conn.execute(
            r#"UPDATE "_meta" SET "format" = ?1 WHERE "id" = ?2 AND "kind" = 'column'"#,
            rusqlite::params![serde_json::to_string(format)?, c.id],
        )?;
    }
    for o in c.choices() {
        insert_node(
            conn,
            &o.id,
            Some(&c.id),
            "option",
            Some(&o.name),
            o.position,
            o.icon.as_deref(),
            o.color.as_ref().map(|c| c.as_str()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )?;
    }
    Ok(())
}

pub(crate) fn insert_view_node(conn: &Connection, v: &ViewMeta) -> Result<()> {
    let (view_kind, filters, sorts, statement) = match &v.data {
        ViewData::Grid(g) => (
            "grid",
            g.filters.as_ref().map(serde_json::to_string).transpose()?,
            Some(serde_json::to_string(&g.sorts)?),
            None,
        ),
        ViewData::Sql(s) => ("sql", None, None, Some(s.statement.clone())),
    };
    insert_node(
        conn,
        &v.id,
        v.table_id.as_deref(),
        "view",
        Some(&v.name),
        v.position,
        v.icon.as_deref(),
        v.color.as_ref().map(|c| c.as_str()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(view_kind),
        filters.as_deref(),
        sorts.as_deref(),
        statement.as_deref(),
        None,
        None,
    )?;
    for wc in &v.columns {
        insert_view_column(
            conn,
            &v.id,
            &wc.id,
            &wc.column_id,
            wc.position,
            wc.width,
            wc.hidden,
            wc.frozen,
        )?;
    }
    Ok(())
}

/// Insert one view-column node under `view_id`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_view_column(
    conn: &Connection,
    view_id: &str,
    id: &str,
    column_id: &str,
    position: i64,
    width: i64,
    hidden: bool,
    frozen: bool,
) -> Result<()> {
    insert_node(
        conn,
        id,
        Some(view_id),
        "view_column",
        None,
        position,
        None,
        None,
        Some(width),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(column_id),
        Some(hidden),
    )?;
    if frozen {
        conn.execute(
            r#"UPDATE "_meta" SET "frozen" = 1 WHERE "id" = ?1 AND "kind" = 'view_column'"#,
            [id],
        )?;
    }
    Ok(())
}

/// Next free position among the children of `parent_id` with the given kind.
pub(crate) fn next_position(conn: &Connection, parent_id: Option<&str>, kind: &str) -> Result<i64> {
    let pos: i64 = match parent_id {
        Some(p) => conn.query_row(
            r#"SELECT COALESCE(MAX("position"), -1) + 1 FROM "_meta"
               WHERE "parent_id" = ?1 AND "kind" = ?2"#,
            rusqlite::params![p, kind],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            r#"SELECT COALESCE(MAX("position"), -1) + 1 FROM "_meta"
               WHERE "parent_id" IS NULL AND "kind" = ?1"#,
            [kind],
            |r| r.get(0),
        )?,
    };
    Ok(pos)
}

pub(crate) fn touch_table(conn: &Connection, table_id: &str) -> Result<()> {
    conn.execute(
        r#"UPDATE "_meta" SET "updated_at" = ?1 WHERE "id" = ?2 AND "kind" = 'table'"#,
        rusqlite::params![now_iso(), table_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Builders / validation
// ---------------------------------------------------------------------------

fn validate_choices(choices: &[OptionMeta]) -> Result<()> {
    if choices.len() > 500 {
        return Err(AppError::InvalidInput("选项过多（最多 500）".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for c in choices {
        let name = ident::validate_user_name("选项名", &c.name)?;
        if !seen.insert(name.clone()) {
            return Err(AppError::AlreadyExists(format!("选项 {name}")));
        }
    }
    Ok(())
}

fn build_choices(new: &[NewChoice], base_position: i64) -> Result<Vec<OptionMeta>> {
    let mut out = Vec::with_capacity(new.len());
    for (i, c) in new.iter().enumerate() {
        let name = ident::validate_user_name("选项名", &c.name)?;
        out.push(OptionMeta {
            id: c
                .id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(new_id),
            name,
            icon: normalize_icon(c.icon.as_deref())?,
            color: normalize_color(c.color.as_deref())?,
            position: base_position + i as i64,
        });
    }
    validate_choices(&out)?;
    Ok(out)
}

/// Build a [`ColumnMeta`] for a new column (id, physical name, timestamp).
pub(crate) fn build_column_meta(
    table_id: &str,
    new: &NewColumn,
    position: i64,
) -> Result<ColumnMeta> {
    let name = ident::validate_user_name("列名", &new.name)?;
    let icon = normalize_icon(new.icon.as_deref())?;
    let color = normalize_column_color(new.color.as_deref())?;
    let align = normalize_column_align(new.align.as_deref())?;
    let default_value = new.default_value.as_ref().filter(|v| !v.is_null()).cloned();
    let id = new_id();
    let sql_name = ident::column_sql_name(&id);

    let data = match new.col_type {
        ColumnType::Text => ColumnData::Text { sql_name },
        ColumnType::Number => ColumnData::Number { sql_name },
        ColumnType::Date => ColumnData::Date { sql_name },
        ColumnType::Checkbox => ColumnData::Checkbox { sql_name },
        ColumnType::Select => ColumnData::Select {
            sql_name,
            choices: build_choices(&new.choices, 0)?,
        },
        ColumnType::MultiSelect => ColumnData::MultiSelect {
            sql_name,
            choices: build_choices(&new.choices, 0)?,
        },
        ColumnType::Relation => {
            let target = new
                .target_table_id
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::InvalidInput("关联列必须指定目标表".into()))?;
            ColumnData::Relation(RelationData {
                target_table_id: target,
                single: new.single,
                origin_id: None,
            })
        }
        ColumnType::Formula => {
            let expr = new
                .formula_expr
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| AppError::InvalidInput("公式不能为空".into()))?;
            ColumnData::Formula(FormulaData {
                sql_name,
                expr,
                result_type: new.formula_result_type.unwrap_or(FormulaResultType::Number),
            })
        }
    };

    let meta = ColumnMeta {
        id,
        table_id: table_id.to_string(),
        name,
        position,
        width: 160,
        icon,
        color,
        align,
        default_value,
        format: new.format.clone(),
        created_at: now_iso(),
        data,
    };
    if let Some(format) = &meta.format {
        format.validate(meta.effective_type())?;
    }
    Ok(meta)
}

/// Validate a column default: literals go through the same type/choice checks
/// as cell writes, and date literals are additionally checked with SQLite's
/// `datetime()` so metadata can never hold a value the table CHECK rejects.
pub(crate) fn validate_default_value(
    conn: &Connection,
    col: &ColumnMeta,
    value: &serde_json::Value,
) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    let resolved = default_cell_value(col, value)?;
    if col.col_type() == ColumnType::Date {
        let raw = resolved.as_str().unwrap_or_default();
        let ok: bool = conn.query_row("SELECT datetime(?1) IS NOT NULL", [raw], |r| r.get(0))?;
        if !ok {
            return Err(AppError::InvalidInput("日期默认值格式无效".into()));
        }
    }
    Ok(())
}
