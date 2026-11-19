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
  created_at: string;
}

export interface NewColumn {
  name: string;
  type: ColumnType;
  opts?: ColumnOpts;
}

export interface ColumnPatch {
  name?: string;
  type?: ColumnType;
  opts?: ColumnOpts;
  position?: number;
  width?: number;
  visible?: boolean;
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
  value: unknown;
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

export type ViewConfig =
  | {
      kind: "grid";
      filters: FilterNode | null;
      sorts: SortSpec[];
      hidden_columns: string[];
    }
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

export interface CommandError {
  kind: string;
  message: string;
}
