// Read-only summary of the active grid view's filters/sorts. The view tabs only
// show the view name, so without this the rules are invisible until the panel
// is opened again. Collapsed by default to keep the grid area intact.

import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { ColumnMeta, FilterNode, ViewMeta } from "../types";
import { isFilterGroup } from "../types";
import { t } from "../i18n";
import { formatFilterValue, filterRuleCount, OP_LABELS } from "./filterModel";
import { IconChevronDown, IconSliders, IconSortAsc, IconSortDesc } from "./icons";

function columnLabel(col: ColumnMeta | undefined): string {
  if (!col) return t("viewConfig.unknownColumn");
  return col.icon ? `${col.icon} ${col.name}` : col.name;
}

export default function ViewConfigBar({
  view,
  columns,
  onEdit,
}: {
  view: ViewMeta;
  columns: ColumnMeta[];
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const colById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  if (view.data.kind !== "grid") return null;
  const { filters, sorts } = view.data;
  const filterCount = filterRuleCount(filters);
  const showFilters = filterCount > 0;
  const showSorts = sorts.length > 0;
  if (!showFilters && !showSorts) return null;

  const renderFilter = (node: FilterNode, key: string): ReactNode => {
    if (isFilterGroup(node)) {
      const joiner = node.op === "and" ? t("viewConfig.and") : t("viewConfig.or");
      return (
        <span className="view-config-group" key={key}>
          {node.children.map((child, i) => (
            <Fragment key={`${key}.${i}`}>
              {i > 0 && <span className="view-config-join">{joiner}</span>}
              {renderFilter(child, `${key}.${i}`)}
            </Fragment>
          ))}
        </span>
      );
    }

    const col = colById.get(node.column_id);
    const value = formatFilterValue(col, node);
    return (
      <span className="view-config-chip" key={key}>
        <span className="view-config-chip-col">{columnLabel(col)}</span>
        <span className="view-config-chip-op">{OP_LABELS[node.op]}</span>
        {value && <span className="view-config-chip-value">{value}</span>}
      </span>
    );
  };

  const summary = [
    showFilters ? t("viewConfig.filterCount", { count: filterCount }) : "",
    showSorts ? t("viewConfig.sortCount", { count: sorts.length }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="view-config">
      <button
        type="button"
        className="view-config-head"
        aria-expanded={open}
        title={open ? t("viewConfig.collapse") : t("viewConfig.expand")}
        onClick={() => setOpen((value) => !value)}
      >
        <IconChevronDown size={12} className={open ? "view-config-caret open" : "view-config-caret"} />
        <IconSliders size={13} />
        <span>{summary}</span>
      </button>
      <button type="button" className="btn ghost small view-config-edit" onClick={onEdit}>
        {t("viewConfig.edit")}
      </button>
      {open && (
        <div className="view-config-body">
          {showFilters && filters && (
            <div className="view-config-section">
              <span className="view-config-label">{t("filter.filters")}</span>
              <div className="view-config-chips">{renderFilter(filters, "f")}</div>
            </div>
          )}
          {showSorts && (
            <div className="view-config-section">
              <span className="view-config-label">{t("filter.sorts")}</span>
              <div className="view-config-chips">
                {sorts.map((sort, i) => {
                  const col = colById.get(sort.column_id);
                  return (
                    <span className="view-config-chip" key={`${sort.column_id}.${i}`}>
                      <span className="view-config-chip-col">{columnLabel(col)}</span>
                      <span className="view-config-chip-op">
                        {sort.desc ? t("filter.desc") : t("filter.asc")}
                      </span>
                      {sort.desc ? <IconSortDesc size={12} /> : <IconSortAsc size={12} />}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}