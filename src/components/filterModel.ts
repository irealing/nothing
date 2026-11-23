// Shared, UI-level filter vocabulary. Kept out of FilterSortPanel so the
// read-only view summary and the editable panel can never drift apart.

import { t } from "../i18n";
import { choicesOf } from "../types";
import type { ColumnMeta, FilterNode, FilterOp, FilterRule, Json } from "../types";

export type FilterKind =
  | "text"
  | "select"
  | "multi_select"
  | "number"
  | "date"
  | "checkbox"
  | "relation";

export const OP_LABELS: Record<FilterOp, string> = {
  eq: t("ops.eq"),
  neq: t("ops.neq"),
  contains: t("ops.contains"),
  not_contains: t("ops.not_contains"),
  starts_with: t("ops.starts_with"),
  ends_with: t("ops.ends_with"),
  is_empty: t("ops.is_empty"),
  is_not_empty: t("ops.is_not_empty"),
  gt: t("ops.gt"),
  gte: t("ops.gte"),
  lt: t("ops.lt"),
  lte: t("ops.lte"),
  in: t("ops.in"),
  not_in: t("ops.not_in"),
  before: t("ops.before"),
  after: t("ops.after"),
  on: t("ops.on"),
};

export const OPS_BY_KIND: Record<FilterKind, FilterOp[]> = {
  text: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  select: ["eq", "neq", "contains", "is_empty", "is_not_empty", "in", "not_in"],
  multi_select: ["contains", "not_contains", "is_empty", "is_not_empty", "in"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"],
  date: ["before", "after", "on", "eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"],
  checkbox: ["eq", "neq"],
  relation: ["is_empty", "is_not_empty"],
};

export const NO_VALUE_OPS: FilterOp[] = ["is_empty", "is_not_empty"];

export function effectiveKind(col: ColumnMeta | undefined): FilterKind {
  if (!col) return "text";
  const type = col.data.kind;
  if (type === "formula") {
    const result = col.data.result_type;
    if (result === "number") return "number";
    if (result === "date") return "date";
    if (result === "checkbox") return "checkbox";
    return "text";
  }
  if (type === "relation") return "relation";
  if (type === "multi_select") return "multi_select";
  if (type === "select") return "select";
  if (type === "number") return "number";
  if (type === "date") return "date";
  if (type === "checkbox") return "checkbox";
  return "text";
}

export function isListOp(op: FilterOp): boolean {
  return op === "in" || op === "not_in";
}

function blank(value: Json): boolean {
  return value === null || value === undefined || value === "";
}

/** Type-appropriate starting value when a rule is first added. */
export function initialFilterValue(kind: FilterKind): Json {
  if (kind === "number") return 0;
  if (kind === "checkbox") return true;
  return "";
}

/**
 * Keep the stored value shape in sync with the operator: `in/not_in` are
 * arrays, everything else is scalar. Called when the column or operator
 * changes so a scalar never reaches an array-only SQL branch (and vice versa).
 */
export function normalizeFilterValue(kind: FilterKind, op: FilterOp, value: Json): Json {
  if (NO_VALUE_OPS.includes(op)) return null;

  if (isListOp(op)) {
    const items = Array.isArray(value) ? value : blank(value) ? [] : [value];
    if (kind === "number") {
      return items.map((item) => Number(item)).filter((n) => !Number.isNaN(n));
    }
    return items.map((item) => String(item));
  }

  if (Array.isArray(value)) {
    const first = value[0];
    if (kind === "number") {
      const n = Number(first);
      return Number.isNaN(n) ? 0 : n;
    }
    if (kind === "checkbox") return Boolean(first);
    return first === null || first === undefined ? "" : String(first);
  }

  if (kind === "number") {
    return typeof value === "number" ? value : Number(value ?? 0) || 0;
  }
  if (kind === "checkbox") {
    return typeof value === "boolean" ? value : value === "true";
  }
  if (blank(value)) return "";
  return value;
}

export function filterRuleCount(node: FilterNode | null): number {
  if (!node) return 0;
  if (!("children" in node)) return 1;
  return node.children.reduce((sum, child) => sum + filterRuleCount(child), 0);
}

function choiceLabel(col: ColumnMeta | undefined, name: string): string {
  if (!col) return name;
  const choice = choicesOf(col).find((c) => c.name === name);
  return choice?.icon ? `${choice.icon} ${name}` : name;
}

/** Human-readable value used by the collapsed view summary. */
export function formatFilterValue(col: ColumnMeta | undefined, rule: FilterRule): string {
  if (NO_VALUE_OPS.includes(rule.op)) return "";

  const raw = Array.isArray(rule.value) ? rule.value : [rule.value];
  const values = raw.filter((value) => value !== null && value !== undefined && value !== "");
  if (values.length === 0) return t("viewConfig.noValue");

  const kind = effectiveKind(col);
  return values
    .map((value) => {
      if (kind === "checkbox") {
        return value === true || value === "true" ? t("filter.checked") : t("filter.unchecked");
      }
      if (kind === "select" || kind === "multi_select") {
        return choiceLabel(col, String(value));
      }
      if (kind === "date" && typeof value === "string") return value.slice(0, 10);
      return String(value);
    })
    .join(t("viewConfig.valueSeparator"));
}