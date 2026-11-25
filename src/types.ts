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

/** Curated presentation palette tokens (never a hex value). */
export type PresetColor =
  | "gray"
  | "brown"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "plum"
  | "pink"
  | "crimson"
  | "red";

/**
 * A presentation color: a palette token or a user-picked `#rrggbb` value.
 * Custom colors are presentation data only; they never reach the SQL.
 */
export type ColumnColor = PresetColor | `#${string}`;

/** Explicit cell alignment; `null` on a column means "by type". */
export type ColumnAlign = "left" | "center" | "right";

/** Presentation-only number/date cell formatting (stored in `_meta.format`). */
export type NumberStyle = "plain" | "currency" | "percent";
export type Currency = "cny" | "usd" | "eur" | "gbp" | "jpy";
export type DateStyle = "date" | "date_time" | "iso";

export type ColumnFormat =
  | {
      kind: "number";
      style: NumberStyle;
      currency: Currency | null;
      /** 0–6 fraction digits. */
      decimals: number;
      thousands: boolean;
    }
  | { kind: "date"; style: DateStyle };

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
  /** Presentation-only number/date format; `null` renders the raw value. */
  format: ColumnFormat | null;
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

/** The type whose value semantics the column follows (formulas: result type). */
export function effectiveType(col: ColumnMeta): ColumnType {
  const result = formulaResultType(col);
  return result ?? colType(col);
}

/** The column's default presentation format, used when the user enables it. */
export function defaultColumnFormat(type: ColumnType | FormulaResultType): ColumnFormat {
  if (type === "date") return { kind: "date", style: "date" };
  return { kind: "number", style: "plain", currency: null, decimals: 0, thousands: true };
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
  format?: ColumnFormat | null;
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
  /** New presentation format; omission keeps the current one. */
  format?: ColumnFormat | null;
  /** Remove the current presentation format. */
  clear_format?: boolean;
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
  /** Present on a read-only summary view; absent/null on a normal grid. */
  aggregate?: AggregateConfig | null;
}

// ---- summary views ----

export type AggregateOp =
  | "count_rows"
  | "count_non_empty"
  | "count_distinct"
  | "sum"
  | "avg"
  | "min"
  | "max";

export interface AggregateMetric {
  op: AggregateOp;
  /** Source column id; `null` only for `count_rows`. */
  column_id: string | null;
}

export interface AggregateSort {
  /** Index into `metrics`; `null` sorts by the group fields. */
  metric: number | null;
  desc: boolean;
}

export interface AggregateConfig {
  group_by: string[];
  metrics: AggregateMetric[];
  sort: AggregateSort | null;
}

/** Default summary: no grouping, one row count metric. */
export function defaultAggregateConfig(): AggregateConfig {
  return {
    group_by: [],
    metrics: [{ op: "count_rows", column_id: null }],
    sort: null,
  };
}

export type AggregateColumnKind = "group" | "metric";
export type AggregateValueType = "text" | "number" | "date" | "checkbox";

export interface AggregateColumn {
  kind: AggregateColumnKind;
  column_id: string | null;
  op: AggregateOp | null;
  value_type: AggregateValueType;
  format: ColumnFormat | null;
}

export interface AggregateResult {
  columns: AggregateColumn[];
  rows: Json[][];
  total_groups: number;
  base_rows: number;
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
  /** Part of this view's frozen left prefix. */
  frozen: boolean;
}

export interface ViewColumnPatch {
  column_id: string;
  position?: number;
  width?: number;
  hidden?: boolean;
  frozen?: boolean;
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

/** A grid view that renders grouped aggregate rows instead of table rows. */
export type AggregateView = ViewMeta & {
  kind: "grid";
  data: { kind: "grid" } & GridConfig & { aggregate: AggregateConfig };
};

export function isAggregateView(
  view: ViewMeta | null | undefined,
): view is AggregateView {
  return (
    !!view &&
    view.kind === "grid" &&
    view.data.kind === "grid" &&
    !!view.data.aggregate
  );
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

/** One row plus display titles for every relation cell it carries. */
export interface RowDetail {
  row: Row;
  titles: Record<string, string>;
}

/** Undo payload for a row delete (opaque to the UI, typed for safety). */
export interface RowSnapshot {
  rid: string;
  created: string;
  updated: string;
  cells: Cells;
}

export interface LinkSnapshot {
  /** Source relation column id (reverse columns share this junction). */
  column_id: string;
  a: string;
  b: string;
  ord: number;
}

export interface DeleteSnapshot {
  table_id: string;
  rows: RowSnapshot[];
  links: LinkSnapshot[];
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
  | ({ kind: "sql" } & SqlResult)
  | ({ kind: "aggregate" } & AggregateResult);

export interface WorkspaceInfo {
  path: string;
  format_version: number;
}

/** Build metadata for the About dialog; `build_time` is RFC3339 UTC. */
export interface AppInfo {
  version: string;
  /** `git describe --tags --long --always --dirty`, or "unknown" when built without git. */
  git: string;
  branch: string;
  build_time: string;
  platform: string;
  tauri_version: string;
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
