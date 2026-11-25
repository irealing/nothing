// Shared model for the read-only summary view: which columns can be grouped,
// which metrics a column supports, and the labels shown in the config panel.

import { t } from "../i18n";
import type {
  AggregateConfig,
  AggregateMetric,
  AggregateOp,
  ColumnMeta,
} from "../types";
import { defaultAggregateConfig, effectiveType, isReverse } from "../types";

export { defaultAggregateConfig };

const GROUPABLE = new Set(["text", "number", "select", "date", "checkbox"]);

export function isGroupableColumn(col: ColumnMeta): boolean {
  return !isReverse(col) && GROUPABLE.has(effectiveType(col));
}

export function groupableColumns(columns: ColumnMeta[]): ColumnMeta[] {
  return columns.filter(isGroupableColumn);
}

/** Ops supported by one source column (count_rows is added separately). */
export function metricOpsForColumn(col: ColumnMeta): AggregateOp[] {
  if (!isGroupableColumn(col)) return [];
  const kind = effectiveType(col);
  const ops: AggregateOp[] = ["count_non_empty", "count_distinct"];
  if (kind === "number") ops.push("sum", "avg", "min", "max");
  if (kind === "checkbox") ops.push("sum");
  if (kind === "date") ops.push("min", "max");
  return ops;
}

export function opNeedsColumn(op: AggregateOp): boolean {
  return op !== "count_rows";
}

export const OP_LABELS: Record<AggregateOp, string> = {
  count_rows: t("aggregate.ops.count_rows"),
  count_non_empty: t("aggregate.ops.count_non_empty"),
  count_distinct: t("aggregate.ops.count_distinct"),
  sum: t("aggregate.ops.sum"),
  avg: t("aggregate.ops.avg"),
  min: t("aggregate.ops.min"),
  max: t("aggregate.ops.max"),
};

/** `sum` on a checkbox is the checked count, not a numeric total. */
export function metricOpLabel(op: AggregateOp, col: ColumnMeta | undefined): string {
  if (op === "sum" && col && effectiveType(col) === "checkbox") {
    return t("aggregate.ops.checked");
  }
  return OP_LABELS[op];
}

export function listMetricOps(columns: ColumnMeta[]): AggregateOp[] {
  const ops = new Set<AggregateOp>(["count_rows"]);
  for (const col of columns) {
    for (const op of metricOpsForColumn(col)) ops.add(op);
  }
  return [...ops];
}

export function columnsForOp(op: AggregateOp, columns: ColumnMeta[]): ColumnMeta[] {
  if (op === "count_rows") return [];
  return columns.filter((col) => metricOpsForColumn(col).includes(op));
}

export function metricColumn(
  metric: AggregateMetric,
  columns: ColumnMeta[],
): ColumnMeta | undefined {
  if (!metric.column_id) return undefined;
  return columns.find((col) => col.id === metric.column_id);
}

/** Label for a metric header, e.g. "工时 · 求和". */
export function metricLabel(metric: AggregateMetric, columns: ColumnMeta[]): string {
  if (metric.op === "count_rows") return OP_LABELS.count_rows;
  const col = metricColumn(metric, columns);
  if (!col) return `${OP_LABELS[metric.op]} · ${t("aggregate.unknownColumn")}`;
  return `${col.name} · ${metricOpLabel(metric.op, col)}`;
}

/** Label for the config panel's metric row (compact, no "column ·"). */
export function metricConfigLabel(metric: AggregateMetric, columns: ColumnMeta[]): string {
  if (metric.op === "count_rows") return OP_LABELS.count_rows;
  const col = metricColumn(metric, columns);
  return col?.name ?? t("aggregate.unknownColumn");
}

export function cloneAggregateConfig(cfg: AggregateConfig | null | undefined): AggregateConfig {
  const source = cfg ?? defaultAggregateConfig();
  return {
    group_by: [...source.group_by],
    metrics: source.metrics.map((m) => ({ ...m })),
    sort: source.sort ? { ...source.sort } : null,
  };
}

export function sameMetric(a: AggregateMetric, b: AggregateMetric): boolean {
  return a.op === b.op && (a.column_id ?? null) === (b.column_id ?? null);
}

/** First metric not already present, used by the "add metric" button. */
export function nextMetric(
  metrics: AggregateMetric[],
  columns: ColumnMeta[],
): AggregateMetric | null {
  const candidates: AggregateMetric[] = [{ op: "count_rows", column_id: null }];
  for (const op of listMetricOps(columns)) {
    if (op === "count_rows") continue;
    for (const col of columnsForOp(op, columns)) {
      candidates.push({ op, column_id: col.id });
    }
  }
  return candidates.find((c) => !metrics.some((m) => sameMetric(m, c))) ?? null;
}

/** Keep the value shape valid when the operator changes. */
export function normalizeMetric(op: AggregateOp, columns: ColumnMeta[]): AggregateMetric {
  if (op === "count_rows") return { op, column_id: null };
  const options = columnsForOp(op, columns);
  return { op, column_id: options[0]?.id ?? null };
}

/** Return a user-facing error for an invalid draft, or null. */
export function validateAggregateConfig(
  cfg: AggregateConfig,
  columns: ColumnMeta[],
): string | null {
  if (cfg.metrics.length === 0) return t("aggregate.error.noMetrics");
  if (cfg.metrics.length > 8) return t("aggregate.error.metricLimit");
  if (cfg.group_by.length > 3) return t("aggregate.error.groupLimit");
  if (new Set(cfg.group_by).size !== cfg.group_by.length) {
    return t("aggregate.error.duplicateGroup");
  }
  for (const id of cfg.group_by) {
    const col = columns.find((c) => c.id === id);
    if (!col || !isGroupableColumn(col)) return t("aggregate.error.invalidGroup");
  }
  for (const metric of cfg.metrics) {
    if (metric.op === "count_rows") {
      if (metric.column_id) return t("aggregate.error.unexpectedColumn");
      continue;
    }
    const col = columns.find((c) => c.id === metric.column_id);
    if (!col || !metricOpsForColumn(col).includes(metric.op)) {
      return t("aggregate.error.invalidMetric");
    }
  }
  if (new Set(cfg.metrics.map((m) => `${m.op}:${m.column_id ?? ""}`)).size !== cfg.metrics.length) {
    return t("aggregate.error.duplicateMetric");
  }
  if (cfg.sort?.metric != null && cfg.sort.metric >= cfg.metrics.length) {
    return t("aggregate.error.invalidSort");
  }
  return null;
}