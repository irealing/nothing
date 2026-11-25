import { useMemo, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import type {
  AggregateConfig,
  AggregateOp,
  FilterNode,
  ViewMeta,
} from "../types";
import { PanelDialog } from "../ui/Dialog";
import { Select } from "../ui/Field";
import { t } from "../i18n";
import {
  IconPlus,
  IconSigma,
  IconSortAsc,
  IconSortDesc,
  IconX,
} from "./icons";
import FilterEditor, { colLabel, normalizeFilters, pruneFilters } from "./FilterEditor";
import {
  OP_LABELS,
  cloneAggregateConfig,
  columnsForOp,
  defaultAggregateConfig,
  groupableColumns,
  isGroupableColumn,
  listMetricOps,
  metricColumn,
  nextMetric,
  normalizeMetric,
  opNeedsColumn,
  validateAggregateConfig,
} from "./aggregateModel";

export default function AggregateConfigPanel({
  view,
  onClose,
}: {
  view: ViewMeta;
  onClose: () => void;
}) {
  const columns = useWorkspace((s) => s.columns);
  const updateView = useWorkspace((s) => s.updateView);
  const initial = view.data.kind === "grid" ? view.data : null;
  const [filters, setFilters] = useState<FilterNode | null>(() =>
    normalizeFilters(initial?.filters ?? null),
  );
  const [draft, setDraft] = useState<AggregateConfig>(() =>
    cloneAggregateConfig(initial?.aggregate),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const groupOptions = useMemo(() => groupableColumns(columns), [columns]);
  const canAddGroup = useMemo(
    () =>
      draft.group_by.length < 3 &&
      groupOptions.some((c) => !draft.group_by.includes(c.id)),
    [draft.group_by, groupOptions],
  );
  const opOptions = useMemo(
    () => listMetricOps(columns).filter((op) => op === "count_rows" || columnsForOp(op, columns).length > 0),
    [columns],
  );
  const next = nextMetric(draft.metrics, columns);
  const canAddMetric = !!next && draft.metrics.length < 8;

  const patch = (next: Partial<AggregateConfig>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const addGroup = () => {
    if (draft.group_by.length >= 3) return;
    const used = new Set(draft.group_by);
    const candidate = groupOptions.find((c) => !used.has(c.id));
    if (candidate) patch({ group_by: [...draft.group_by, candidate.id] });
  };

  const changeGroup = (index: number, columnId: string) => {
    const group_by = draft.group_by.map((id, i) => (i === index ? columnId : id));
    patch({ group_by });
  };

  const removeGroup = (index: number) => {
    patch({ group_by: draft.group_by.filter((_, i) => i !== index) });
  };

  const changeOp = (index: number, op: AggregateOp) => {
    const metrics = draft.metrics.map((m, i) => {
      if (i !== index) return m;
      if (
        opNeedsColumn(op) &&
        m.column_id &&
        columnsForOp(op, columns).some((c) => c.id === m.column_id)
      ) {
        return { op, column_id: m.column_id };
      }
      return normalizeMetric(op, columns);
    });
    patch({ metrics });
  };

  const changeMetricColumn = (index: number, columnId: string) => {
    const metrics = draft.metrics.map((m, i) =>
      i === index ? { ...m, column_id: columnId } : m,
    );
    patch({ metrics });
  };

  const addMetric = () => {
    if (!next || draft.metrics.length >= 8) return;
    patch({ metrics: [...draft.metrics, next] });
  };

  const removeMetric = (index: number) => {
    if (draft.metrics.length <= 1) return;
    const metrics = draft.metrics.filter((_, i) => i !== index);
    let sort = draft.sort;
    if (sort?.metric != null) {
      if (sort.metric === index) sort = null;
      else if (sort.metric > index) sort = { ...sort, metric: sort.metric - 1 };
    }
    patch({ metrics, sort });
  };

  const sortValue = draft.sort?.metric != null ? `m${draft.sort.metric}` : "group";
  const sortDesc = draft.sort?.desc ?? false;
  const sortOptions = [
    { value: "group", label: t("aggregate.sortGroup") },
    ...draft.metrics.map((metric, index) => ({
      value: `m${index}`,
      label: metricColumn(metric, columns)?.name ?? OP_LABELS[metric.op],
    })),
  ];

  const save = async () => {
    const message = validateAggregateConfig(draft, columns);
    if (message) {
      setError(message);
      return;
    }
    setSaving(true);
    try {
      await updateView(view.id, {
        data: {
          kind: "grid",
          filters: pruneFilters(filters),
          sorts: initial?.sorts ?? [],
          aggregate: draft,
        },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelDialog
      title={
        <>
          <IconSigma size={15} /> {t("aggregate.configTitle")}
        </>
      }
      badge={<span className="panel-head-view">{view.name}</span>}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              setDraft(defaultAggregateConfig());
              setError(null);
            }}
          >
            {t("common.reset")}
          </button>
          <div className="toolbar-spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            {t("filter.saveApply")}
          </button>
        </>
      }
    >
      <FilterEditor
        filters={filters}
        sorts={[]}
        columns={columns}
        onFiltersChange={(next) => {
          setFilters(next);
          setError(null);
        }}
        onSortsChange={() => {}}
        showSorts={false}
      />

      <section>
        <h4>{t("aggregate.groupBy")}</h4>
        {draft.group_by.length === 0 && (
          <p className="hint">{t("aggregate.noGroups")}</p>
        )}
        {draft.group_by.map((columnId, index) => {
          const current = columns.find((c) => c.id === columnId);
          return (
            <div className="filter-rule aggregate-row" key={`${columnId}-${index}`}>
              <Select
                value={columnId}
                ariaLabel={t("aggregate.groupBy")}
                onChange={(value) => changeGroup(index, value)}
                options={[
                  ...groupOptions
                    .filter(
                      (c) =>
                        c.id === columnId || !draft.group_by.includes(c.id),
                    )
                    .map((c) => ({ value: c.id, label: colLabel(c) })),
                  ...(current && isGroupableColumn(current)
                    ? []
                    : [{ value: columnId, label: t("aggregate.unknownColumn"), disabled: true }]),
                ]}
              />
              <button
                className="btn-icon danger"
                title={t("aggregate.removeGroup")}
                onClick={() => removeGroup(index)}
              >
                <IconX size={13} />
              </button>
            </div>
          );
        })}
        <button
          className="btn dashed"
          disabled={!canAddGroup}
          onClick={addGroup}
        >
          <IconPlus size={14} /> {t("aggregate.addGroup")}
        </button>
        <p className="hint">{t("aggregate.groupLimit")}</p>
        <p className="hint">{t("aggregate.groupHint")}</p>
      </section>

      <section>
        <h4>{t("aggregate.metrics")}</h4>
        {draft.metrics.map((metric, index) => {
          const columnOptions = columnsForOp(metric.op, columns);
          const current = metric.column_id
            ? columns.find((c) => c.id === metric.column_id)
            : undefined;
          return (
            <div className="filter-rule aggregate-row" key={index}>
              <Select
                value={metric.op}
                ariaLabel={t("aggregate.metrics")}
                onChange={(value) => changeOp(index, value as AggregateOp)}
                options={[
                  ...opOptions.map((op) => ({ value: op, label: OP_LABELS[op] })),
                  ...(opOptions.includes(metric.op)
                    ? []
                    : [{ value: metric.op, label: OP_LABELS[metric.op], disabled: true }]),
                ]}
              />
              {opNeedsColumn(metric.op) && (
                <Select
                  value={metric.column_id ?? ""}
                  ariaLabel={t("aggregate.column")}
                  onChange={(value) => changeMetricColumn(index, value)}
                  options={[
                    ...columnOptions.map((c) => ({ value: c.id, label: colLabel(c) })),
                    ...(current && columnOptions.some((c) => c.id === current.id)
                      ? []
                      : metric.column_id
                        ? [
                            {
                              value: metric.column_id,
                              label: t("aggregate.unknownColumn"),
                              disabled: true,
                            },
                          ]
                        : []),
                  ]}
                />
              )}
              <div className="toolbar-spacer" />
              <button
                className="btn-icon danger"
                title={t("aggregate.removeMetric")}
                disabled={draft.metrics.length <= 1}
                onClick={() => removeMetric(index)}
              >
                <IconX size={13} />
              </button>
            </div>
          );
        })}
        <button
          className="btn dashed"
          disabled={!canAddMetric}
          onClick={addMetric}
        >
          <IconPlus size={14} /> {t("aggregate.addMetric")}
        </button>
        <p className="hint">{t("aggregate.metricLimit")}</p>
      </section>

      {draft.group_by.length > 0 && (
        <section>
          <h4>{t("aggregate.sort")}</h4>
          <div className="filter-rule aggregate-row">
            <Select
              value={sortValue}
              ariaLabel={t("aggregate.sort")}
              onChange={(value) => {
                const metric = value === "group" ? null : Number(value.slice(1));
                patch({ sort: { metric, desc: sortDesc } });
              }}
              options={sortOptions}
            />
            <button
              className="btn sort-dir"
              onClick={() => patch({ sort: { metric: draft.sort?.metric ?? null, desc: !sortDesc } })}
              title={sortDesc ? t("aggregate.asc") : t("aggregate.desc")}
            >
              {sortDesc ? <IconSortDesc size={14} /> : <IconSortAsc size={14} />}
              {sortDesc ? t("aggregate.desc") : t("aggregate.asc")}
            </button>
          </div>
        </section>
      )}

      {error && <div className="form-error">{error}</div>}
    </PanelDialog>
  );
}