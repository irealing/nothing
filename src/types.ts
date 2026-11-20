// TypeScript mirrors of the Rust core types (serde JSON representations).
// Keep in sync with crates/nothing-core/src/schema/mod.rs and query/mod.rs.

export type ColumnType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "relation"
  | "formula";

export type FormulaResultType = "number" | "text" | "date" | "checkbox";

/** Presentation palette token for a column (never a hex value). */
export type ColumnColor =
  | "gray"
  | "blue"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "purple"
  | "pink"
  | "brown";

/** Explicit cell alignment; `null` on a column means "by type". */
export type ColumnAlign = "left" | "center" | "right";

export interface Choice {
  id: string;
  name: string;
}

export type ColumnOpts =
  | { kind: "plain" }
  | { kind: "select"; choices: Choice[] }
  | { kind: "multi_select"; choices: Choice[] }
  | {
      kind: "relation";
      target_table_id: string;
      single: boolean;
      reverse_name?: string | null;
    }
  | { kind: "formula"; expr: string; result_type: FormulaResultType };

export interface TableMeta {
  id: string;
  name: string;
  sql_name: string;
  title_col_id: string | null;
  icon: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ColumnMeta {
  id: string;
  table_id: string;
  name: string;
  sql_name: string;
  type: ColumnType;
  opts: ColumnOpts;
  position: number;
  width: number;
  visible: boolean;
  is_reverse: boolean;
  reverse_of: string | null;
  /** Optional emoji shown before the column name. */
  icon: string | null;
  /** Optional palette token tinting the header and cells. */
  color: ColumnColor | null;
  /** Explicit alignment; `null` means "by type" (numbers right, rest left). */
  align: ColumnAlign | null;
  /**
   * Value written to new rows when the cell is not supplied.
   * Date columns also accept the dynamic `{ kind: "now" }` token.
   */
  default_value: Json | null;
  created_at: string;
}

export interface NewColumn {
  name: string;
  type: ColumnType;
  opts?: ColumnOpts;
  icon?: string | null;
  color?: ColumnColor | null;
  align?: ColumnAlign | null;
  default_value?: Json | null;
}

/** `icon`/`color`/`align` accept "" to clear them. */
export interface ColumnPatch {
  name?: string;
  type?: ColumnType;
  opts?: ColumnOpts;
  position?: number;
  width?: number;
  visible?: boolean;
  icon?: string;
  color?: string;
  align?: string;
  /** New default; omission keeps the current one (JSON null cannot signal
   * "clear" because it deserializes to a missing field). */
  default_value?: Json;
  /** Remove the current default value. */
  clear_default?: boolean;
}

// ---- views ----

export type ViewKind = "grid" | "sql";

export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "before"
  | "after"
  | "on";

export interface FilterRule {
  column_id: string;
  op: FilterOp;
  value: Json;
}

export interface FilterGroup {
  op: "and" | "or";
  children: FilterNode[];
}

export type FilterNode = FilterGroup | FilterRule;

export function isFilterGroup(n: FilterNode): n is FilterGroup {
  return "children" in n;
}

export interface SortSpec {
  column_id: string;
  desc: boolean;
}

export interface GridConfig {
  filters: FilterNode | null;
  sorts: SortSpec[];
  hidden_columns: string[];
}

export type ViewConfig =
  | ({ kind: "grid" } & GridConfig)
  | { kind: "sql"; statement: string };

export interface ViewMeta {
  id: string;
  table_id: string | null;
  name: string;
  kind: ViewKind;
  config: ViewConfig;
  position: number;
  created_at: string;
}

export interface NewView {
  table_id: string | null;
  name: string;
  kind: ViewKind;
  config: ViewConfig;
}

export interface ViewPatch {
  name?: string;
  config?: ViewConfig;
  position?: number;
}

// ---- rows & results ----

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Cells = Record<string, Json>;

export interface Row {
  rid: string;
  created: string;
  updated: string;
  cells: Cells;
}

export interface RowPage {
  columns: ColumnMeta[];
  rows: Row[];
  total: number;
  titles: Record<string, string>;
}

export interface SqlColumn {
  name: string;
  decl_type: string | null;
}

export interface SqlResult {
  columns: SqlColumn[];
  rows: Json[][];
}

export type ViewResult =
  | ({ kind: "grid" } & RowPage)
  | ({ kind: "sql" } & SqlResult);

export interface WorkspaceInfo {
  path: string;
  format_version: number;
}

// ---- app settings (plain-text `settings.json` in the OS app config dir) ----

export interface RecentWorkspace {
  path: string;
  opened_at: string;
  /** False when the file is gone or its drive is off-line right now. */
  exists: boolean;
}

export interface SettingsView {
  last_workspace: RecentWorkspace | null;
  recent: RecentWorkspace[];
}

export interface WorkspaceUiState {
  table_id: string | null;
  view_id: string | null;
}

// ---- CSV import ----

export interface CsvPreview {
  /** First record; shown as the editable header row by default. */
  first_row: string[];
  /** Data rows after the first record (preview only). */
  rows: string[][];
  /** Total record count in the file, including the first record. */
  total_rows: number;
  width: number;
  delimiter: string;
  encoding: string;
  ragged: boolean;
  suggested_types: ColumnType[];
}

export interface ImportCsvOptions {
  path: string;
  table_name: string;
  use_header: boolean;
  headers: string[];
  types: ColumnType[];
}

export interface ImportReport {
  table: TableMeta;
  imported: number;
  invalid_cells: number;
}

export interface CommandError {
  kind: string;
  message: string;
}
