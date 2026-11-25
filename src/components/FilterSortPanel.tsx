// Grid-view config panel: filter tree (and/or groups), sorts and hidden
// columns. Edits a local draft; 保存 persists via view_update and the backend
// recompiles the parameterized SQL. The rule editor itself is shared with the
// inline view-config bar (FilterEditor.tsx).

import { useMemo, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import type { GridConfig, ViewMeta } from "../types";
import { IconSliders } from "./icons";
import { PanelDialog } from "../ui/Dialog";
import { Checkbox } from "../ui/Field";
import { t } from "../i18n";
import FilterEditor, { editableConfig, pruneFilters } from "./FilterEditor";

export default function FilterSortPanel({ view, onClose }: { view: ViewMeta; onClose: () => void }) {
  const columns = useWorkspace((s) => s.columns);
  const updateView = useWorkspace((s) => s.updateView);
  const updateViewColumn = useWorkspace((s) => s.updateViewColumn);

  const [draft, setDraft] = useState<GridConfig>(() =>
    editableConfig(view.data.kind === "grid" ? view.data : { filters: null, sorts: [] }),
  );
  const hiddenIds = useMemo(
    () => new Set(view.columns.filter((c) => c.hidden).map((c) => c.column_id)),
    [view.columns],
  );

  const save = async () => {
    await updateView(view.id, {
      data: {
        kind: "grid",
        filters: pruneFilters(draft.filters),
        sorts: draft.sorts,
        aggregate: draft.aggregate ?? null,
      },
    });
    onClose();
  };

  return (
    <PanelDialog
      title={
        <>
          <IconSliders size={15} /> {t("filter.title")}
        </>
      }
      badge={<span className="panel-head-view">{view.name}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => setDraft({ filters: null, sorts: [] })}>
            {t("filter.reset")}
          </button>
          <div className="toolbar-spacer" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={() => void save()}>
            {t("filter.saveApply")}
          </button>
        </>
      }
    >
      <FilterEditor
        filters={draft.filters}
        sorts={draft.sorts}
        columns={columns}
        onFiltersChange={(filters) => setDraft((d) => ({ ...d, filters }))}
        onSortsChange={(sorts) => setDraft((d) => ({ ...d, sorts }))}
      />

      <section>
        <h4>{t("filter.hidden")}</h4>
        <div className="hidden-cols">
          {columns.map((c) => (
            <Checkbox
              className="hidden-col"
              key={c.id}
              checked={hiddenIds.has(c.id)}
              onChange={(checked) => {
                void updateViewColumn(view.id, c.id, { hidden: checked });
              }}
            >
              {c.icon ? `${c.icon} ${c.name}` : c.name}
            </Checkbox>
          ))}
        </div>
      </section>
    </PanelDialog>
  );
}