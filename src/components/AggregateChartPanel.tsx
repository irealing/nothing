// Chart renderers for the read-only summary view. Both charts are pure
// SVG/CSS: no chart dependency, no canvas, and every color comes from a token.

import { useMemo } from "react";
import type { ReactNode } from "react";
import type { AggregateResult, ColumnMeta } from "../types";
import { t } from "../i18n";
import { Select } from "../ui/Field";
import {
  buildBarSeries,
  buildPieSeries,
  chartColor,
  chartMetrics,
  percentText,
} from "./aggregateChartModel";
import type { ChartMetric, ChartMode } from "./aggregateChartModel";

/** SVG donut geometry (viewBox is 100×100). */
const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ChartNotice({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-card">
        <p>{children}</p>
        {action}
      </div>
    </div>
  );
}

function BarChart({
  result,
  metric,
}: {
  result: AggregateResult;
  metric: ChartMetric;
}) {
  const series = useMemo(() => buildBarSeries(result, metric), [result, metric]);
  if (!series.hasData) return <ChartNotice>{t("aggregate.chart.empty")}</ChartNotice>;

  return (
    <div className="aggregate-chart-scroll">
      <div className="bar-chart" role="list">
        {series.points.map((point, index) => (
          <div className="bar-row" role="listitem" key={index}>
            <span className="bar-label" title={point.label}>
              {point.label}
            </span>
            <div className="bar-track">
              {series.hasNegative && (
                <span className="bar-zero" style={{ left: `${series.zero}%` }} />
              )}
              {point.value !== null && point.width > 0 && (
                <span
                  className={point.negative ? "bar-fill negative" : "bar-fill"}
                  style={{ left: `${point.left}%`, width: `${point.width}%` }}
                />
              )}
            </div>
            <span className="bar-value">{point.display}</span>
          </div>
        ))}
      </div>
      {series.total > series.shown && (
        <div className="aggregate-chart-foot">
          {t("aggregate.chart.barLimit", {
            count: series.shown,
            total: series.total,
          })}
        </div>
      )}
    </div>
  );
}

function PieChart({
  result,
  metric,
}: {
  result: AggregateResult;
  metric: ChartMetric;
}) {
  const series = useMemo(() => buildPieSeries(result, metric), [result, metric]);
  if (!series.hasData) return <ChartNotice>{t("aggregate.chart.empty")}</ChartNotice>;

  const gap = series.slices.length > 1 ? 0.8 : 0;
  let offset = 0;

  return (
    <div className="aggregate-chart-scroll">
      <div className="pie-chart">
        <div className="pie-figure">
          <svg
            viewBox="0 0 100 100"
            role="img"
            aria-label={t("aggregate.chart.aria", { metric: metric.label })}
          >
            {series.slices.map((slice, index) => {
              const length = Math.min(
                CIRCUMFERENCE,
                (slice.value / series.total) * CIRCUMFERENCE,
              );
              const dash = Math.max(length - gap, 0);
              const dashOffset = -offset;
              offset += length;
              return (
                <circle
                  key={index}
                  cx="50"
                  cy="50"
                  r={RADIUS}
                  fill="none"
                  stroke={chartColor(slice.colorIndex)}
                  strokeWidth={18}
                  strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                  strokeDashoffset={dashOffset}
                  transform="rotate(-90 50 50)"
                >
                  <title>
                    {`${slice.label} · ${slice.display} (${percentText(slice.percent)})`}
                  </title>
                </circle>
              );
            })}
          </svg>
          <div className="pie-center">
            <strong>{series.displayTotal}</strong>
            <span>{t("aggregate.chart.total")}</span>
          </div>
        </div>
        <ul className="pie-legend">
          {series.slices.map((slice, index) => (
            <li key={index} className={slice.isOther ? "other" : undefined}>
              <span
                className="pie-dot"
                style={{ background: chartColor(slice.colorIndex) }}
              />
              <span className="pie-label" title={slice.label}>
                {slice.label}
              </span>
              <span className="pie-value">{slice.display}</span>
              <span className="pie-percent">{percentText(slice.percent)}</span>
            </li>
          ))}
        </ul>
      </div>
      {(series.merged > 0 || series.skipped > 0) && (
        <div className="aggregate-chart-foot">
          {series.merged > 0 && (
            <span>{t("aggregate.chart.otherHint", { count: series.merged })}</span>
          )}
          {series.skipped > 0 && (
            <span>{t("aggregate.chart.skipped", { count: series.skipped })}</span>
          )}
        </div>
      )}
    </div>
  );
}

export default function AggregateChartPanel({
  result,
  columns,
  mode,
  metricIndex,
  onMetricChange,
  onConfigure,
}: {
  result: AggregateResult | null;
  columns: ColumnMeta[];
  mode: Exclude<ChartMode, "table">;
  metricIndex: number | null;
  onMetricChange: (index: number) => void;
  onConfigure: () => void;
}) {
  const metrics = useMemo(() => chartMetrics(result, columns), [result, columns]);
  const metric =
    metrics.find((candidate) => candidate.index === metricIndex) ??
    metrics[0] ??
    null;

  if (!result) return <ChartNotice>{t("aggregate.loading")}</ChartNotice>;
  if (result.rows.length === 0) {
    return <ChartNotice>{t("aggregate.emptyRows")}</ChartNotice>;
  }
  if (!result.columns.some((column) => column.kind === "group")) {
    return (
      <ChartNotice
        action={
          <button className="btn ghost" type="button" onClick={onConfigure}>
            {t("aggregate.config")}
          </button>
        }
      >
        {t("aggregate.chart.needGroups")}
      </ChartNotice>
    );
  }
  if (!metric) return <ChartNotice>{t("aggregate.chart.noMetric")}</ChartNotice>;

  return (
    <div className="aggregate-chart-wrap">
      {metrics.length > 1 && (
        <div className="aggregate-chart-bar">
          <span className="aggregate-chart-label">
            {t("aggregate.chart.metric")}
          </span>
          <Select
            value={String(metric.index)}
            onChange={(value) => onMetricChange(Number(value))}
            ariaLabel={t("aggregate.chart.metric")}
            options={metrics.map((candidate) => ({
              value: String(candidate.index),
              label: candidate.label,
            }))}
          />
        </div>
      )}
      {mode === "bar" ? (
        <BarChart result={result} metric={metric} />
      ) : (
        <PieChart result={result} metric={metric} />
      )}
    </div>
  );
}