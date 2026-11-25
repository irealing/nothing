import { useMemo, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import type { ViewMeta } from "../types";
import { t } from "../i18n";
import {
  IconChartBar,
  IconChartPie,
  IconSigma,
  IconSliders,
  IconTable,
} from "./icons";
import { metricOpLabel, OP_LABELS } from "./aggregateModel";
import AggregateConfigPanel from "./AggregateConfigPanel";
import AggregateChartPanel from "./AggregateChartPanel";
import type { ChartMode } from "./aggregateChartModel";
import AggregateResultTable from "./AggregateResultTable";

/** Read-only grouped aggregate view. Configuration lives in the view metadata. */
export default function AggregateViewPanel({ view }: { view: ViewMeta }) {
  const columns = useWorkspace((s) => s.columns);
  const result = useWorkspace((s) => s.aggregateResult);
  const error = useWorkspace((s) => s.error);
  const [configOpen, setConfigOpen] = useState(false);
  // Presentation only: deliberately not persisted to `_meta` or localStorage.
  const [mode, setMode] = useState<ChartMode>("table");
  const [metricIndex, setMetricIndex] = useState<number | null>(null);
  const config = view.data.kind === "grid" ? view.data.aggregate ?? null : null;

  const summary = useMemo(() => {
    if (!config) return "";
    const groups = config.group_by.map(
      (id) => columns.find((c) => c.id === id)?.name ?? t("aggregate.unknownColumn"),
    );
    const metrics = config.metrics.map((metric) => {
      const col = metric.column_id
        ? columns.find((c) => c.id === metric.column_id)
        : undefined;
      if (metric.op === "count_rows") return OP_LABELS.count_rows;
      const op = metricOpLabel(metric.op, col);
      return col ? `${col.name} · ${op}` : op;
    });
    const groupText =
      groups.length > 0 ? groups.join(t("viewConfig.valueSeparator")) : t("aggregate.noGroups");
    return `${groupText}  ·  ${metrics.join(t("viewConfig.valueSeparator"))}`;
  }, [columns, config]);

  if (!config) return null;

  const modes = [
    { value: "table", label: t("aggregate.mode.table"), icon: IconTable },
    { value: "bar", label: t("aggregate.mode.bar"), icon: IconChartBar },
    { value: "pie", label: t("aggregate.mode.pie"), icon: IconChartPie },
  ] as const;

  return (
    <div className="table-view aggregate-view">
      <div className="toolbar">
        <div className="toolbar-title-group">
          <h2 className="toolbar-title">
            <IconSigma size={16} /> {view.name}
          </h2>
          <span className="pill-count">{t("aggregate.readOnly")}</span>
        </div>
        <div className="toolbar-spacer" />
        {result && (
          <span className="toolbar-count">
            {t("aggregate.groups", { count: result.total_groups })} ·{" "}
            {t("aggregate.baseRows", { count: result.base_rows })}
          </span>
        )}
        <div
          className="aggregate-mode-switch"
          role="radiogroup"
          aria-label={t("aggregate.mode.label")}
        >
          {modes.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              aria-label={label}
              title={label}
              className="aggregate-mode-btn"
              onClick={() => setMode(value)}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => setConfigOpen(true)}>
          <IconSliders size={14} /> {t("aggregate.config")}
        </button>
      </div>

      <div className="view-config aggregate-bar">
        <button
          type="button"
          className="view-config-head"
          title={t("aggregate.config")}
          onClick={() => setConfigOpen(true)}
        >
          <IconSigma size={13} />
          <span className="aggregate-summary-text">{summary}</span>
        </button>
      </div>

      <div className="aggregate-result-wrap">
        {error && !result ? (
          <div className="empty-state">
            <div className="empty-card">
              <p>{error}</p>
            </div>
          </div>
        ) : mode === "table" ? (
          <AggregateResultTable result={result} columns={columns} />
        ) : (
          <AggregateChartPanel
            result={result}
            columns={columns}
            mode={mode}
            metricIndex={metricIndex}
            onMetricChange={setMetricIndex}
            onConfigure={() => setConfigOpen(true)}
          />
        )}
        {result && result.rows.length > 0 && result.rows.length < result.total_groups && (
          <div className="aggregate-truncated">
            {t("aggregate.truncated", { count: result.rows.length })}
          </div>
        )}
      </div>

      {configOpen && (
        <AggregateConfigPanel
          key={view.id}
          view={view}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </div>
  );
}