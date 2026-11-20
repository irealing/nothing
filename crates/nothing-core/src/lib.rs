//! nothing-core: storage kernel for the nothing app.
//!
//! Encrypted SQLite (SQLCipher) workspaces with Notion-style tables mapped to
//! real SQLite constructs: typed columns, CHECK constraints, generated columns
//! for formulas, FTS5 search, junction tables with cascading foreign keys for
//! relations, and real SQL VIEWs.
//!
//! See AGENTS.md at the repository root for the binding rules (铁律) that all
//! changes to this crate must follow.

pub mod db;
pub mod error;
pub mod import;
pub mod query;
pub mod schema;

pub use db::migrate::CURRENT_FORMAT_VERSION;
pub use db::{Workspace, MAGIC};
pub use error::AppError;
pub use import::{read_csv_preview, CsvPreview, ImportCsvOptions, ImportReport};
pub use query::{Cells, Row, RowPage, SqlColumn, SqlResult, ViewResult};
pub use schema::{
    Choice, ColumnAlign, ColumnColor, ColumnMeta, ColumnOpts, ColumnPatch, ColumnType, FilterNode,
    FilterOp, FilterRule, FormulaOpts, FormulaResultType, GridConfig, LogicOp, NewColumn, NewView,
    PlainOpts, RelationOpts, SelectOpts, SortSpec, SqlConfig, TableMeta, ViewConfig, ViewKind,
    ViewMeta, ViewPatch,
};
