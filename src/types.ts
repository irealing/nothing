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

/** A select / multi-select choice node. */
export interface Choice {
  id: string;
  name: string;
  icon: string | null;
  color: ColumnColor | null;
  position: number;
}

export interface NewChoice {
  id?: string | null;
  name: string;
  icon?: string | null;
  color?: string | null;
}

/** Polymorphic column payload: the variant tag *is* the column type. */
export type ColumnData =
  | { kind: "text"; sql_name: string }
  | { kind: "number"; sql_name: string }
  | { kind: "date"; sql_name: string }
  | { kind: "checkbox"; sql_name: string }
  | { kind: "select"; sql_name: string; choices: Choice[] }
  | { kind: "multi_select"; sql_name: string; choices: Choice[] }
  | { kind: "relation"; target_table_id: string; single: boolean; origin_id: string | null }
  | { kind: "formula"; sql_name: string; expr: string; result_type: FormulaResultType };

export interface TableMeta {
  id: string;
  name: string;
  sql_name: string;
  title_col_id: string | null;
  icon: string | null;
  color: ColumnColor | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ColumnMeta {
  id: string;
  table_id: string;
  name: string;
  position: number;
  /** Default width; the effective width in a view is on that view's column. */
  width: number;
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
  data: ColumnData;
}

// ---- helpers over the polymorphic payload ----

export function colType(col: ColumnMeta): ColumnType {
  return col.data.kind;
}

export function sqlNameOf(col: ColumnMeta): string | null {
  return "sql_name" in col.data ? col.data.sql_name : null;
}

export function choicesOf(col: ColumnMeta): Choice[] {
  return col.data.kind === "select" || col.data.kind === "multi_select"
    ? col.data.choices
    : [];
}

export function formulaResultType(col: ColumnMeta): FormulaResultType | null {
  return col.data.kind === "formula" ? col.data.result_type : null;
}

export function isReverse(col: ColumnMeta): boolean {
  return col.data.kind === "relation" && col.data.origin_id !== null;
}

export function originIdOf(col: ColumnMeta): string | null {
  return col.data.kind === "relation" ? col.data.origin_id : null;
}

export interface NewColumn {
  name: string;
  type: ColumnType;
  choices?: NewChoice[];
  target_table_id?: string | null;
  single?: boolean;
  reverse_name?: string | null;
  formula_expr?: string | null;
  formula_result_type?: FormulaResultType | null;
  icon?: string | null;
  color?: ColumnColor | null;
  align?: ColumnAlign | null;
  default_value?: Json | null;
}

/** `icon`/`color`/`align` accept "" to clear them. */
export interface ColumnPatch {
  name?: string;
  type?: ColumnType;
  choices?: NewChoice[];
  target_table_id?: string;
  single?: boolean;
  formula_expr?: string;
  formula_result_type?: FormulaResultType;
  position?: number;
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
}

export interface SqlConfig {
  statement: string;
}

export type ViewData =
  | ({ kind: "grid" } & GridConfig)
  | ({ kind: "sql" } & SqlConfig);

/** A grid view's own column node: width/order/hidden are per view. */
export interface ViewColumnMeta {
  id: string;
  column_id: string;
  position: number;
  width: number;
  hidden: boolean;
}

export interface ViewColumnPatch {
  column_id: string;
  position?: number;
  width?: number;
  hidden?: boolean;
}

export interface ViewMeta {
  id: string;
  table_id: string | null;
  name: string;
  kind: ViewKind;
  icon: string | null;
  color: ColumnColor | null;
  position: number;
  created_at: string;
  data: ViewData;
  columns: ViewColumnMeta[];
}

export interface NewView {
  table_id: string | null;
  name: string;
  kind: ViewKind;
  data: ViewData;
}

export interface ViewPatch {
  name?: string;
  data?: ViewData;
  icon?: string;
  color?: string;
  position?: number;
  columns?: ViewColumnPatch[];
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
