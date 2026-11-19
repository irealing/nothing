import { useCallback, useMemo, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  GridColumnIcon,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import { useWorkspace } from "../stores/workspace";
import type { ColumnMeta, Json, Row } from "../types";

function asString(v: Json | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function isEditable(col: ColumnMeta): boolean {
  if (col.is_reverse) return false;
  return ["text", "number", "date", "checkbox", "select"].includes(col.type);
}

/** Map a backend cell value to a glide-data-grid cell. */
function cellFor(col: ColumnMeta, value: Json | undefined, titles: Record<string, string>): GridCell {
  const copyData = asString(value);
  switch (col.type) {
    case "number":
      return {
        kind: GridCellKind.Number,
        data: typeof value === "number" ? value : undefined,
        displayData: value === null || value === undefined ? "" : String(value),
        copyData,
        readonly: !isEditable(col),
        allowOverlay: true,
      };
    case "checkbox":
      return {
        kind: GridCellKind.Boolean,
        data: value === true,
        copyData: value ? "true" : "false",
        allowOverlay: false,
        readonly: !isEditable(col),
      };
    case "formula": {
      const rt = col.opts.kind === "formula" ? col.opts.result_type : "text";
      if (rt === "number") {
        return {
          kind: GridCellKind.Number,
          data: typeof value === "number" ? value : undefined,
          displayData: value === null || value === undefined ? "" : String(value),
          copyData,
          readonly: true,
          allowOverlay: false,
        };
      }
      if (rt === "checkbox") {
        return {
          kind: GridCellKind.Boolean,
          data: value === true,
          copyData,
          allowOverlay: false,
          readonly: true,
        };
      }
      return { kind: GridCellKind.Text, data: copyData, displayData: copyData, copyData, readonly: true, allowOverlay: false };
    }
    case "relation": {
      // value = array of rids; display resolved titles (batched by backend)
      const display = Array.isArray(value)
        ? value.map((rid) => titles[String(rid)] ?? "…").join(", ")
        : "";
      return { kind: GridCellKind.Text, data: display, displayData: display, copyData: display, readonly: true, allowOverlay: false };
    }
    case "multi_select":
      return { kind: GridCellKind.Text, data: copyData, displayData: copyData, copyData, readonly: true, allowOverlay: false };
    default:
      // text / select / date — plain string editing (rich editors arrive in M4)
      return {
        kind: GridCellKind.Text,
        data: copyData,
        displayData: copyData,
        copyData,
        readonly: !isEditable(col),
        allowOverlay: isEditable(col),
      };
  }
}

function headerIcon(col: ColumnMeta): GridColumnIcon | undefined {
  switch (col.type) {
    case "text": return GridColumnIcon.HeaderString;
    case "number": return GridColumnIcon.HeaderNumber;
    case "checkbox": return GridColumnIcon.HeaderBoolean;
    case "date": return GridColumnIcon.HeaderDate;
    case "select": return GridColumnIcon.HeaderSingleValue;
    case "multi_select": return GridColumnIcon.HeaderLookup;
    case "relation": return GridColumnIcon.HeaderReference;
    case "formula": return GridColumnIcon.HeaderMath;
    default: return undefined;
  }
}

export default function TableView() {
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const tables = useWorkspace((s) => s.tables);
  const columns = useWorkspace((s) => s.columns);
  const page = useWorkspace((s) => s.page);
  const insertRow = useWorkspace((s) => s.insertRow);
  const updateCell = useWorkspace((s) => s.updateCell);
  const deleteRows = useWorkspace((s) => s.deleteRows);
  const updateColumn = useWorkspace((s) => s.updateColumn);
  const searchRows = useWorkspace((s) => s.searchRows);
  const searchQuery = useWorkspace((s) => s.searchQuery);
  const [localQuery, setLocalQuery] = useState("");
  const [gridSelection, setGridSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });

  const table = tables.find((t) => t.id === activeTableId) ?? null;
  const rows: Row[] = useMemo(() => page?.rows ?? [], [page]);
  const titles = useMemo(() => page?.titles ?? {}, [page]);

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((c) => ({
        title: c.name + (c.is_reverse ? "（反向）" : ""),
        id: c.id,
        width: c.width || 160,
        icon: headerIcon(c),
      })),
    [columns],
  );

  const getCellContent = useCallback(
    ([col, rowIdx]: Item): GridCell => {
      const meta = columns[col];
      const r = rows[rowIdx];
      if (!meta || !r) {
        return { kind: GridCellKind.Loading, copyData: "", allowOverlay: false };
      }
      return cellFor(meta, r.cells[meta.id], titles);
    },
    [columns, rows, titles],
  );

  const onCellEdited = useCallback(
    ([col, rowIdx]: Item, newValue: EditableGridCell) => {
      const meta = columns[col];
      const r = rows[rowIdx];
      if (!meta || !r || !activeTableId) return;
      let value: Json;
      switch (newValue.kind) {
        case GridCellKind.Text:
          value = newValue.data === "" ? null : newValue.data;
          break;
        case GridCellKind.Number:
          value = newValue.data === undefined ? null : newValue.data;
          break;
        case GridCellKind.Boolean:
          value = newValue.data === true;
          break;
        default:
          return;
      }
      void updateCell(r.rid, meta.id, value);
    },
    [columns, rows, activeTableId, updateCell],
  );

  const selectedRids = useMemo(() => {
    const out: string[] = [];
    for (const i of gridSelection.rows) {
      const r = rows[i];
      if (r) out.push(r.rid);
    }
    return out;
  }, [gridSelection, rows]);

  if (!table || !activeTableId) {
    return (
      <div className="empty-state">
        <p>👈 在左侧选择或创建一个表格开始</p>
      </div>
    );
  }

  return (
    <div className="table-view">
      <div className="toolbar">
        <h2 className="toolbar-title">{table.name}</h2>
        <span className="toolbar-count">
          {page ? `${page.total} 行` : ""}
          {searchQuery ? `（搜索“${searchQuery}”）` : ""}
        </span>
        <div className="toolbar-spacer" />
        <input
          className="search-input"
          type="text"
          placeholder="搜索…（回车）"
          value={localQuery}
          onChange={(e) => setLocalQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void searchRows(localQuery.trim());
            if (e.key === "Escape") {
              setLocalQuery("");
              void searchRows("");
            }
          }}
        />
        <button className="btn" onClick={() => void insertRow({})}>
          ＋ 新增行
        </button>
        <button
          className="btn danger"
          disabled={selectedRids.length === 0}
          onClick={() => {
            if (window.confirm(`删除选中的 ${selectedRids.length} 行？关联链接会一并级联删除。`)) {
              void deleteRows(selectedRids);
            }
          }}
        >
          删除选中（{selectedRids.length}）
        </button>
      </div>
      <div className="grid-wrap">
        <DataEditor
          columns={gridColumns}
          rows={rows.length}
          getCellContent={getCellContent}
          onCellEdited={onCellEdited}
          rowMarkers={{ kind: "both" }}
          gridSelection={gridSelection}
          onGridSelectionChange={setGridSelection}
          trailingRowOptions={{ tint: true, sticky: true, hint: "新增行…" }}
          onRowAppended={() => {
            void insertRow({});
          }}
          onColumnResize={(column, newSize) => {
            if (column.id) void updateColumn(column.id, { width: newSize });
          }}
          smoothScrollX={true}
          smoothScrollY={true}
          getCellsForSelection={true}
          rangeSelect="rect"
          columnSelect="none"
        />
      </div>
    </div>
  );
}
