// Inline editor for the active grid view's filters/sorts. The collapsed row
// keeps the rules visible at a glance; expanding it mounts the same shared
// FilterEditor the modal panel uses, so the summary is actionable rather than
// read-only. Hidden columns stay in the modal panel (opened from here).

import { useEffect, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import type { ColumnMeta, GridConfig, ViewMeta } from "../types";
import { t } from "../i18n";
import { filterRuleCount } from "./filterModel";
import { IconChevronDown, IconSliders } from "./icons";
import FilterEditor, { editableConfig, pruneFilters } from "./FilterEditor";

const EMPTY_SORTS: GridConfig["sorts"] = [];

export default function ViewConfigBar({
  view,
  columns,
  onOpenPanel,
}: {
  view: ViewMeta;
  columns: ColumnMeta[];
  onOpenPanel: () => void;
}) {
  const updateView = useWorkspace((s) => s.updateView);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<GridConfig>(() =>
    editableConfig(view.data.kind === "grid" ? view.data : { filters: null, sorts: [] }),
  );

  const grid = view.data.kind === "grid" ? view.data : null;
  const filters = grid?.filters ?? null;
  const sorts = grid?.sorts ?? EMPTY_SORTS;
  const filterCount = filterRuleCount(filters);
  const showFilters = filterCount > 0;
  const showSorts = sorts.length > 0;

  // A save from the modal panel (or any external view update) replaces the
  // draft while the inline editor is closed. Open edits must survive column
  // resizes and other metadata writes.
  useEffect(() => {
    if (!open) setDraft(editableConfig({ filters, sorts }));
  }, [filters, sorts, open]);

  if (!grid) return null;
  if (!showFilters && !showSorts) return null;

  const summary = [
    showFilters ? t("viewConfig.filterCount", { count: filterCount }) : "",
    showSorts ? t("viewConfig.sortCount", { count: sorts.length }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // Opening always starts from the saved view: a collapsed edit is an abort.
  const toggle = () => {
    if (!open) setDraft(editableConfig({ filters, sorts }));
    setOpen(!open);
  };

  const cancel = () => {
    setDraft(editableConfig({ filters, sorts }));
    setOpen(false);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateView(view.id, {
        data: {
          kind: "grid",
          filters: pruneFilters(draft.filters),
          sorts: draft.sorts,
          aggregate: draft.aggregate ?? null,
        },
      });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="view-config">
      <button
        type="button"
        className="view-config-head"
        aria-expanded={open}
        title={open ? t("viewConfig.collapse") : t("viewConfig.expand")}
        onClick={toggle}
      >
        <IconChevronDown size={12} className={open ? "view-config-caret open" : "view-config-caret"} />
        <IconSliders size={13} />
        <span>{summary}</span>
      </button>
      <button
        type="button"
        className="btn ghost small view-config-edit"
        onClick={() => {
          setOpen(false);
          setDraft(editableConfig({ filters, sorts }));
          onOpenPanel();
        }}
      >
        {t("viewConfig.hiddenColumns")}
      </button>
      {open && (
        <>
          <div className="view-config-body">
            <FilterEditor
              filters={draft.filters}
              sorts={draft.sorts}
              columns={columns}
              onFiltersChange={(filters) => setDraft((d) => ({ ...d, filters }))}
              onSortsChange={(sorts) => setDraft((d) => ({ ...d, sorts }))}
            />
          </div>
          <div className="view-config-foot">
            <button
              className="btn ghost small"
              onClick={() => setDraft({ filters: null, sorts: [] })}
            >
              {t("filter.reset")}
            </button>
            <div className="toolbar-spacer" />
            <button className="btn small" onClick={cancel}>
              {t("common.cancel")}
            </button>
            <button className="btn primary small" disabled={saving} onClick={() => void save()}>
              {t("filter.saveApply")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}