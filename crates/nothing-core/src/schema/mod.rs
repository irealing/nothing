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
}

/// Partial update of a column. `None` fields keep their current value.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ColumnPatch {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub col_type: Option<ColumnType>,
    pub opts: Option<ColumnOpts>,
    pub position: Option<i64>,
    pub width: Option<i64>,
    pub visible: Option<bool>,
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
const COLUMN_COLS: &str = r#""id","table_id","name","sql_name","type","opts","position","width","visible","is_reverse","reverse_of","created_at""#;
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
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"#
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
        created_at: now_iso(),
    })
}
