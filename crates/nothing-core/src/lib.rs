//! nothing-core: storage kernel for the Nothing app.
//!
//! Encrypted SQLite (SQLCipher) workspaces with Notion-style tables mapped to
//! real SQLite constructs: typed columns, CHECK constraints, generated columns
//! for formulas, FTS5 search, and junction tables with cascading foreign keys
//! for relations. SQL views are stored metadata executed read-only — there is
//! no physical `CREATE VIEW` object.
//!
//! See AGENTS.md at the repository root for the binding rules (铁律) that all
//! changes to this crate must follow.

pub mod db;
pub mod error;
pub mod import;
pub mod query;
pub mod schema;

pub use db::manifest::CURRENT_FORMAT_VERSION;
pub use db::{Workspace, MAGIC};
pub use error::AppError;
pub use import::{read_csv_preview, CsvPreview, ImportCsvOptions, ImportReport};
pub use query::{
    AggregateColumn, AggregateColumnKind, AggregateResult, AggregateValueType, Cells,
    DeleteSnapshot, LinkSnapshot, Row, RowDetail, RowPage, RowSnapshot, SqlColumn, SqlResult,
    ViewResult,
};
pub use schema::{
    AggregateConfig, AggregateMetric, AggregateOp, AggregateSort, ColumnAlign, ColumnColor,
    ColumnData, ColumnFormat, ColumnMeta, ColumnPatch, ColumnType, Currency, DateStyle, FilterNode,
    FilterOp, FilterRule, FormulaData, FormulaResultType, GridConfig, LogicOp, NewChoice,
    NewColumn, NewView, NumberStyle, OptionMeta, RelationData, SortSpec, SqlConfig, TableMeta,
    ViewColumnMeta, ViewColumnPatch, ViewData, ViewKind, ViewMeta, ViewPatch, COLUMN_COLOR_TOKENS,
};
