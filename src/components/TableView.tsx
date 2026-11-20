import { useCallback, useMemo, useRef, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  GridColumnIcon,
  type CellClickedEventArgs,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type HeaderClickedEventArgs,
  type Item,
} from "@glideapps/glide-data-grid";
import { useWorkspace } from "../stores/workspace";
import type { ColumnMeta, Json, Row } from "../types";
import FilterSortPanel from "./FilterSortPanel";
import ColumnDialog from "./ColumnDialogs";
import { RelationModal, SelectPopover, type Anchor } from "./CellEditors";

function asString(v: Json | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Inline-editable via glide's built-in overlays. */
function isInlineEditable(col: ColumnMeta): boolean {
  if (col.is_reverse) return false;
  return ["text", "number", "date"].includes(col.type);
}

/** Opens a custom popup editor on click. */
function hasPopupEditor(col: ColumnMeta): boolean {
  if (col.type === "relation") return true; // both source and reverse
  if (col.is_reverse) return false;
  return col.type === "select" || col.type === "multi_select";
}

function cellFor(col: ColumnMeta, value: Json | undefined, titles: Record<string, string>): GridCell {
  const copyData = asString(value);
  switch (col.type) {
    case "number":
      return {
        kind: GridCellKind.Number,
        data: typeof value === "number" ? value : undefined,
        displayData: value === null || value === undefined ? "" : String(value),
        copyData,
        readonly: !isInlineEditable(col) && col.type !== "number",
        allowOverlay: !col.is_reverse,
      };
    case "checkbox":
      return {
        kind: GridCellKind.Boolean,
        data: value === true,
        copyData: value ? "true" : "false",
        allowOverlay: false,
        readonly: col.is_reverse,
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
      const display = Array.isArray(value)
        ? (value as Json[]).map((rid) => titles[String(rid)] ?? "…").join(", ")
        : "";
      return {
        kind: GridCellKind.Text,
        data: display,
        displayData: display,
        copyData: display,
        readonly: true,
        allowOverlay: false,
      };
    }
    case "multi_select":
    case "select":
      return {
        kind: GridCellKind.Text,
        data: copyData,
        displayData: copyData,
        copyData,
        readonly: true, // editing happens through the popup editor
        allowOverlay: false,
      };
    default:
      return {
        kind: GridCellKind.Text,
        data: copyData,
        displayData: copyData,
        copyData,
        readonly: !isInlineEditable(col),
        allowOverlay: isInlineEditable(col),
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

interface PickerState {
  col: ColumnMeta;
  rowIdx: number;
  anchor: Anchor;
}

export default function TableView() {
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const tables = useWorkspace((s) => s.tables);
  const columns = useWorkspace((s) => s.columns);
  const views = useWorkspace((s) => s.views);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const page = useWorkspace((s) => s.page);
  const searchQuery = useWorkspace((s) => s.searchQuery);
  const insertRow = useWorkspace((s) => s.insertRow);
  const updateCell = useWorkspace((s) => s.updateCell);
  const deleteRows = useWorkspace((s) => s.deleteRows);
  const deleteColumn = useWorkspace((s) => s.deleteColumn);
  const updateColumn = useWorkspace((s) => s.updateColumn);
  const setTitleColumn = useWorkspace((s) => s.setTitleColumn);
  const searchRows = useWorkspace((s) => s.searchRows);

  const [localQuery, setLocalQuery] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [colMenu, setColMenu] = useState<{ col: ColumnMeta; x: number; y: number } | null>(null);
  const [colDialog, setColDialog] = useState<{ existing: ColumnMeta | null } | null>(null);
  const [gridSelection, setGridSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });
  const gridWrapRef = useRef<HTMLDivElement>(null);

  const table = tables.find((t) => t.id === activeTableId) ?? null;
  const activeView = views.find((v) => v.id === activeViewId) ?? null;
  const rows: Row[] = useMemo(() => page?.rows ?? [], [page]);
  const titles = useMemo(() => page?.titles ?? {}, [page]);

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((c) => ({
        title: c.name + (c.is_reverse ? "（反向）" : ""),
        id: c.id,
        width: c.width || 160,
        icon: headerIcon(c),
        hasMenu: true,
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

  const onCellClicked = useCallback(
    (cell: Item, event: CellClickedEventArgs) => {
      const meta = columns[cell[0]];
      const rowIdx = cell[1];
      if (!meta || !rows[rowIdx] || !hasPopupEditor(meta)) return;
      const rect = gridWrapRef.current?.getBoundingClientRect();
      const b = event.bounds;
      setPicker({
        col: meta,
        rowIdx,
        anchor: {
          x: (rect?.left ?? 0) + b.x,
          y: (rect?.top ?? 0) + b.y,
          width: b.width,
          height: b.height,
        },
      });
    },
    [columns, rows],
  );

  const onHeaderContextMenu = useCallback(
    (colIndex: number, event: HeaderClickedEventArgs) => {
      event.preventDefault();
      const meta = columns[colIndex];
      if (!meta) return;
      const rect = gridWrapRef.current?.getBoundingClientRect();
      const b = event.bounds;
      setColMenu({
        col: meta,
        x: (rect?.left ?? 0) + b.x,
        y: (rect?.top ?? 0) + b.y + b.height,
      });
    },
    [columns],
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

  const pickerRow = picker ? rows[picker.rowIdx] : undefined;

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
        {activeView?.kind === "grid" && (
          <button className="btn" onClick={() => setPanelOpen(true)}>
            ⚙ 筛选 / 排序
          </button>
        )}
        <button className="btn" onClick={() => setColDialog({ existing: null })}>
          ＋ 列
        </button>
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
      <div className="grid-wrap" ref={gridWrapRef}>
        <DataEditor
          columns={gridColumns}
          rows={rows.length}
          getCellContent={getCellContent}
          onCellEdited={onCellEdited}
          onCellClicked={onCellClicked}
          onHeaderContextMenu={onHeaderContextMenu}
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

      {/* ---- popups ---- */}
      {picker && pickerRow && picker.col.type !== "relation" && (
        <SelectPopover
          col={picker.col}
          value={pickerRow.cells[picker.col.id] ?? null}
          anchor={picker.anchor}
          onCommit={(v) => void updateCell(pickerRow.rid, picker.col.id, v)}
          onClose={() => setPicker(null)}
        />
      )}
      {picker && pickerRow && picker.col.type === "relation" && (
        <RelationModal
          col={picker.col}
          value={Array.isArray(pickerRow.cells[picker.col.id])
            ? (pickerRow.cells[picker.col.id] as Json[]).map(String)
            : []}
          onCommit={(rids) => void updateCell(pickerRow.rid, picker.col.id, rids)}
          onClose={() => setPicker(null)}
        />
      )}

      {colMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setColMenu(null)} />
          <div className="dropdown-menu positioned" style={{ left: colMenu.x, top: colMenu.y }}>
            <button
              onClick={() => {
                setColDialog({ existing: colMenu.col });
                setColMenu(null);
              }}
            >
              ✎ 编辑列…
            </button>
            {colMenu.col.type === "text" && !colMenu.col.is_reverse && table.title_col_id !== colMenu.col.id && (
              <button
                onClick={() => {
                  void setTitleColumn(colMenu.col.id);
                  setColMenu(null);
                }}
              >
                ★ 设为标题列
              </button>
            )}
            <button
              onClick={() => {
                void navigator.clipboard.writeText(`${table.sql_name}.${colMenu.col.sql_name}`);
                setColMenu(null);
              }}
            >
              ⧉ 复制 SQL 引用名
            </button>
            {!colMenu.col.is_reverse && table.title_col_id !== colMenu.col.id && (
              <button
                className="danger"
                onClick={() => {
                  const c = colMenu.col;
                  setColMenu(null);
                  if (window.confirm(`删除列「${c.name}」？该列所有数据将被移除。`)) {
                    void deleteColumn(c.id);
                  }
                }}
              >
                🗑 删除列
              </button>
            )}
          </div>
        </>
      )}

      {panelOpen && activeView?.kind === "grid" && (
        <FilterSortPanel view={activeView} onClose={() => setPanelOpen(false)} />
      )}

      {colDialog && (
        <ColumnDialog existing={colDialog.existing} onClose={() => setColDialog(null)} />
      )}
    </div>
  );
}
