// Chart data for read-only summary views. Everything here is derived from an
// `AggregateResult`; the backend stays unaware of chart modes. Values are
// formatted with the metric column's own format so charts match the table.

import { t } from "../i18n";
import type {
  AggregateColumn,
  AggregateResult,
  ColumnMeta,
  Json,
} from "../types";
import {
  aggregateHeaderLabel,
  groupValueText,
  metricValueText,
} from "./aggregateModel";

/** Bar rows rendered per chart; long tails are unreadable and expensive. */
export const BAR_LIMIT = 50;
/** Pie slices before the tail is merged into "其他". */
export const PIE_SLICES = 8;
/** `--chart-1 … --chart-8` in styles.css. */
const CHART_COLORS = 8;

export type ChartMode = "table" | "bar" | "pie";

export interface ChartMetric {
  /** Index into `AggregateResult.columns` and every row. */
  index: number;
  column: AggregateColumn;
  label: string;
}

/** Numeric metrics only: date min/max has no meaningful bar length. */
export function chartMetrics(
  result: AggregateResult | null,
  columns: ColumnMeta[],
): ChartMetric[] {
  if (!result) return [];
  const out: ChartMetric[] = [];
  result.columns.forEach((column, index) => {
    if (column.kind !== "metric" || column.value_type !== "number") return;
    out.push({
      index,
      column,
      label: aggregateHeaderLabel(column, columns),
    });
  });
  return out;
}

function numericValue(value: Json | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Joined label for every group field of one result row. */
export function groupLabel(result: AggregateResult, row: Json[]): string {
  const parts: string[] = [];
  result.columns.forEach((column, index) => {
    if (column.kind === "group") parts.push(groupValueText(column, row[index]));
  });
  return parts.join(" · ");
}

export interface BarPoint {
  label: string;
  value: number | null;
  display: string;
  negative: boolean;
  /** Percentage of the track where the bar starts. */
  left: number;
  /** Percentage of the track the bar spans (0…100). */
  width: number;
}

export interface BarSeries {
  points: BarPoint[];
  shown: number;
  total: number;
  hasNegative: boolean;
  hasData: boolean;
  /** Zero baseline in percent, used to draw the axis for negative values. */
  zero: number;
}

/** Bars keep the result order (and therefore the configured sort). */
export function buildBarSeries(
  result: AggregateResult,
  metric: ChartMetric,
): BarSeries {
  const rows = result.rows.slice(0, BAR_LIMIT);
  const values = rows.map((row) => numericValue(row[metric.index]));
  const finite = values.filter((value): value is number => value !== null);
  const max = finite.length > 0 ? Math.max(0, ...finite) : 0;
  const min = finite.length > 0 ? Math.min(0, ...finite) : 0;
  const span = max - min;
  const zero = span > 0 ? ((0 - min) / span) * 100 : 0;

  const points = rows.map((row, i) => {
    const value = values[i];
    const display = metricValueText(metric.column, value);
    if (value === null || span <= 0) {
      return {
        label: groupLabel(result, row),
        value,
        display,
        negative: false,
        left: zero,
        width: 0,
      };
    }
    const width = (Math.abs(value) / span) * 100;
    return {
      label: groupLabel(result, row),
      value,
      display,
      negative: value < 0,
      left: value < 0 ? zero - width : zero,
      width,
    };
  });

  return {
    points,
    shown: points.length,
    total: result.rows.length,
    hasNegative: min < 0,
    hasData: finite.length > 0,
    zero,
  };
}

export interface PieSlice {
  label: string;
  value: number;
  display: string;
  /** Share of the positive total, 0…100. */
  percent: number;
  /** 0…7, or -1 for the merged "其他" slice. */
  colorIndex: number;
  isOther: boolean;
}

export interface PieSeries {
  slices: PieSlice[];
  total: number;
  displayTotal: string;
  /** Groups merged into "其他". */
  merged: number;
  /** Groups skipped because their value was null, zero or negative. */
  skipped: number;
  hasData: boolean;
}

/**
 * Pie charts can only express non-negative parts, so the series sorts by the
 * metric and keeps the largest slices. Anything beyond `PIE_SLICES` is summed
 * into "其他" to keep the legend readable.
 */
export function buildPieSeries(
  result: AggregateResult,
  metric: ChartMetric,
): PieSeries {
  const entries: { row: Json[]; value: number }[] = [];
  let skipped = 0;
  for (const row of result.rows) {
    const value = numericValue(row[metric.index]);
    if (value === null || value <= 0) {
      skipped++;
      continue;
    }
    entries.push({ row, value });
  }
  entries.sort((a, b) => b.value - a.value);

  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  const kept = entries.slice(0, PIE_SLICES);
  const rest = entries.slice(PIE_SLICES);
  const slices: PieSlice[] = kept.map((entry, index) => ({
    label: groupLabel(result, entry.row),
    value: entry.value,
    display: metricValueText(metric.column, entry.value),
    percent: total > 0 ? (entry.value / total) * 100 : 0,
    colorIndex: index,
    isOther: false,
  }));

  if (rest.length > 0) {
    const value = rest.reduce((sum, entry) => sum + entry.value, 0);
    slices.push({
      label: t("aggregate.chart.other"),
      value,
      display: metricValueText(metric.column, value),
      percent: total > 0 ? (value / total) * 100 : 0,
      colorIndex: -1,
      isOther: true,
    });
  }

  return {
    slices,
    total,
    displayTotal: metricValueText(metric.column, total),
    merged: rest.length,
    skipped,
    hasData: slices.length > 0,
  };
}

/** CSS variable for one series color; "其他" stays neutral. */
export function chartColor(colorIndex: number): string {
  if (colorIndex < 0) return "var(--chart-other)";
  return `var(--chart-${(colorIndex % CHART_COLORS) + 1})`;
}

/** One-decimal percentage, without a trailing `.0`. */
export function percentText(percent: number): string {
  if (percent > 0 && percent < 0.05) return "<0.1%";
  const text = percent.toFixed(1);
  return `${text.endsWith(".0") ? text.slice(0, -2) : text}%`;
}