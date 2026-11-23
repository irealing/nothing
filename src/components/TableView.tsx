import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  GridColumnIcon,
  type CellClickedEventArgs,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type HeaderClickedEventArgs,
  type Item,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import { PAGE_SIZE, useWorkspace } from "../stores/workspace";
import { useTheme } from "../stores/theme";
import { readGridTheme, tagThemeOverride } from "../theme/grid";
import { formatDate } from "../i18n/format";
import { t } from "../i18n";
import { confirm } from "../ui/ConfirmDialog";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import type { ColumnMeta, Json, Row } from "../types";
import { colType, choicesOf, formulaResultType, isReverse, sqlNameOf } from "../types";
import FilterSortPanel from "./FilterSortPanel";
import ViewConfigBar from "./ViewConfigBar";
import ColumnDialog from "./ColumnDialogs";
import { RelationModal, SelectPopover, type Anchor } from "./CellEditors";
import { InlineCellEditor } from "./GridEditors";
import { EmojiMenu } from "../ui/ColumnPickers";
import {
  IconCopy,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSliders,
  IconStar,
  IconTable,
  IconTrash,
  IconX,
} from "./icons";

function asString(v: Json | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Inline-editable through our own floating editor (IME safe). */
function isInlineEditable(col: ColumnMeta): boolean {
  if (isReverse(col)) return false;
  return ["text", "number", "date"].includes(colType(col));
}

/** Opens a custom popup editor on click. */
function hasPopupEditor(col: ColumnMeta): boolean {
  if (colType(col) === "relation") return true; // both source and reverse
  if (isReverse(col)) return false;
  return colType(col) === "select" || colType(col) === "multi_select";
}

/** Synthetic trailing header cell that opens the "add column" dialog. */
const ADD_COLUMN_ID = "__add_column__";

type CellAlign = "left" | "center" | "right";

/** Explicit alignment wins; otherwise numbers (including numeric formulas)
 * read right-aligned and everything else stays left-aligned. */
function cellAlign(col: ColumnMeta): CellAlign {
  if (col.align) return col.align;
  if (colType(col) === "number") return "right";
  if (colType(col) === "formula" && formulaResultType(col) === "number") {
    return "right";
  }
  return "left";
}

function cellFor(col: ColumnMeta, value: Json | undefined, titles: Record<string, string>): GridCell {
  const copyData = asString(value);
  const contentAlign = cellAlign(col);
  switch (colType(col)) {
    case "number":
      return {
        kind: GridCellKind.Number,
        data: typeof value === "number" ? value : undefined,
        displayData: value === null || value === undefined ? "" : String(value),
        copyData,
        contentAlign,
        readonly: false,
        allowOverlay: false,
      };
    case "checkbox":
      return {
        kind: GridCellKind.Boolean,
        data: value === true,
        copyData: value ? "true" : "false",
        contentAlign,
        allowOverlay: false,
        readonly: isReverse(col),
      };
    case "date": {
      const shown = formatDate(value);
      return {
        kind: GridCellKind.Text,
        data: shown,
        displayData: shown,
        copyData,
        contentAlign,
        readonly: isReverse(col),
        allowOverlay: false,
      };
    }
    case "formula": {
      const rt = formulaResultType(col) ?? "text";
      if (rt === "number") {
        return {
          kind: GridCellKind.Number,
          data: typeof value === "number" ? value : undefined,
          displayData: value === null || value === undefined ? "" : String(value),
          copyData,
          contentAlign,
          readonly: true,
          allowOverlay: false,
        };
      }
      if (rt === "checkbox") {
        return {
          kind: GridCellKind.Boolean,
          data: value === true,
          copyData,
          contentAlign,
          allowOverlay: false,
          readonly: true,
        };
      }
      return {
        kind: GridCellKind.Text,
        data: copyData,
        displayData: copyData,
        copyData,
        contentAlign,
        readonly: true,
        allowOverlay: false,
      };
    }
    case "relation": {
      const rids = Array.isArray(value) ? (value as Json[]).map(String) : [];
      const pills = rids.map((rid) => titles[rid] ?? "…");
      return {
        kind: GridCellKind.Bubble,
        data: pills,
        copyData: pills.join(", "),
        contentAlign,
        allowOverlay: false,
      };
    }
    case "multi_select":
    case "select": {
      const choiceIcon = new Map(choicesOf(col).map((c) => [c.name, c.icon]));
      const raw = Array.isArray(value)
        ? (value as Json[]).map((v) => String(v))
        : value === null || value === undefined || value === ""
          ? []
          : [String(value)];
      const pills = raw.map((name) => {
        const icon = choiceIcon.get(name);
        return icon ? `${icon} ${name}` : name;
      });
      return {
        kind: GridCellKind.Bubble,
        data: pills,
        copyData,
        contentAlign,
        allowOverlay: false,
      };
    }
    default:
      return {
        kind: GridCellKind.Text,
        data: copyData,
        displayData: copyData,
        copyData,
        contentAlign,
        readonly: false,
        allowOverlay: false,
      };
  }
}

function headerIcon(col: ColumnMeta): GridColumnIcon | undefined {
  switch (colType(col)) {
    case "text":
      return GridColumnIcon.HeaderString;
    case "number":
      return GridColumnIcon.HeaderNumber;
    case "checkbox":
      return GridColumnIcon.HeaderBoolean;
    case "date":
      return GridColumnIcon.HeaderDate;
    case "select":
      return GridColumnIcon.HeaderSingleValue;
    case "multi_select":
      return GridColumnIcon.HeaderLookup;
    case "relation":
      return GridColumnIcon.HeaderReference;
    case "formula":
      return GridColumnIcon.HeaderMath;
    default:
      return undefined;
  }
}

interface PickerState {
  col: ColumnMeta;
  rowIdx: number;
  anchor: Anchor;
}

interface EditorState {
  colIdx: number;
  rowIdx: number;
  rid: string;
  value: Json;
  anchor: Anchor;
}

/** Rows fetched around the visible region (in row counts). */
const OVERSCAN = PAGE_SIZE * 2;

export default function TableView() {
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const tables = useWorkspace((s) => s.tables);
  const visibleColumns = useWorkspace((s) => s.visibleColumns);
  const views = useWorkspace((s) => s.views);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const total = useWorkspace((s) => s.total);
  const rowsCache = useWorkspace((s) => s.rowsCache);
  const rowsVersion = useWorkspace((s) => s.rowsVersion);
  const dataVersion = useWorkspace((s) => s.dataVersion);
  const titles = useWorkspace((s) => s.titles);
  const searchQuery = useWorkspace((s) => s.searchQuery);
  const fetchWindow = useWorkspace((s) => s.fetchWindow);
  const insertRow = useWorkspace((s) => s.insertRow);
  const updateCell = useWorkspace((s) => s.updateCell);
  const deleteRows = useWorkspace((s) => s.deleteRows);
  const deleteColumn = useWorkspace((s) => s.deleteColumn);
  const updateColumn = useWorkspace((s) => s.updateColumn);
  const updateViewColumn = useWorkspace((s) => s.updateViewColumn);
  const setTitleColumn = useWorkspace((s) => s.setTitleColumn);
  const setTableIcon = useWorkspace((s) => s.setTableIcon);
  const searchRows = useWorkspace((s) => s.searchRows);

  const [localQuery, setLocalQuery] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [colMenu, setColMenu] = useState<{ col: ColumnMeta; x: number; y: number } | null>(null);
  const [headerEmoji, setHeaderEmoji] = useState<{ col: ColumnMeta; x: number; y: number } | null>(null);
  const [colDialog, setColDialog] = useState<{ existing: ColumnMeta | null } | null>(null);
  const [gridSelection, setGridSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });
  const gridRef = useRef<DataEditorRef | null>(null);
  const visibleRange = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: PAGE_SIZE });

  const table = tables.find((t) => t.id === activeTableId) ?? null;
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  // After writes (dataVersion bumps) re-pull whatever is on screen.
  useEffect(() => {
    const r = visibleRange.current;
    void fetchWindow(Math.max(0, r.y - OVERSCAN), r.y + r.height + OVERSCAN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  // Switching tables/views must not leave a stale floating editor behind.
  useEffect(() => {
    setEditor(null);
    setPicker(null);
    setHeaderEmoji(null);
  }, [activeTableId, activeViewId]);

  const columns = visibleColumns;
  const duplicateRows = useWorkspace((s) => s.duplicateRows);
  const layout = activeView?.columns ?? [];
  const resolvedTheme = useTheme((s) => s.resolved);
  const gridTheme = useMemo(() => readGridTheme(), [resolvedTheme]);
  const gridColumns: GridColumn[] = useMemo(
    () => [
      ...columns.map((c) => ({
        title: `${c.icon ? `${c.icon} ` : ""}${c.name}${isReverse(c) ? t("column.reverseSuffix") : ""}`,
        id: c.id,
        width: c.width || 160,
        // A custom emoji replaces the default type icon in the header.
        icon: c.icon ? undefined : headerIcon(c),
        hasMenu: true,
        ...(c.color ? { themeOverride: tagThemeOverride(c.color) } : {}),
      })),
      // Trailing "+" header cell: a synthetic column so it lives in the header
      // strip and opens the add-column dialog on click.
      { title: "+", id: ADD_COLUMN_ID, width: 44, hasMenu: false },
    ],
    [columns, resolvedTheme],
  );

  const getRow = useCallback((idx: number): Row | undefined => rowsCache.get(idx), [rowsCache, rowsVersion]);

  const getCellContent = useCallback(
    ([col, rowIdx]: Item): GridCell => {
      // Synthetic "add column" cell: render blank instead of a loading spinner.
      if (col >= columns.length) {
        return {
          kind: GridCellKind.Text,
          data: "",
          displayData: "",
          copyData: "",
          readonly: true,
          allowOverlay: false,
        };
      }
      const meta = columns[col];
      const r = getRow(rowIdx);
      if (!meta) {
        return { kind: GridCellKind.Loading, copyData: "", allowOverlay: false };
      }
      if (!r) {
        // Cache miss (fast scrolling): schedule a window fetch and show a
        // loading cell; the rowsVersion bump re-renders with real data.
        queueMicrotask(() =>
          void fetchWindow(Math.max(0, rowIdx - OVERSCAN), rowIdx + OVERSCAN),
        );
        return { kind: GridCellKind.Loading, copyData: "", allowOverlay: false };
      }
      return cellFor(meta, r.cells[meta.id], titles);
    },
    [columns, getRow, titles, fetchWindow],
  );

  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      visibleRange.current = range;
      void fetchWindow(Math.max(0, range.y - OVERSCAN), range.y + range.height + OVERSCAN);
    },
    [fetchWindow],
  );

  const onCellEdited = useCallback(
    ([col, rowIdx]: Item, newValue: EditableGridCell) => {
      const meta = columns[col];
      const r = getRow(rowIdx);
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
    [columns, getRow, activeTableId, updateCell],
  );

  const anchorFor = useCallback((col: number, row: number): Anchor | null => {
    // glide's bounds are already client (viewport) coordinates.
    const bounds = gridRef.current?.getBounds(col, row);
    if (!bounds) return null;
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }, []);

  // Shift is tracked manually so shift+click keeps extending the range
  // instead of dropping straight into the cell editor.
  const shiftHeld = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftHeld.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftHeld.current = false;
    };
    const blur = () => {
      shiftHeld.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const openInlineEditor = useCallback(
    (colIdx: number, rowIdx: number, anchor: Anchor) => {
      const meta = columns[colIdx];
      const r = getRow(rowIdx);
      if (!meta || !r || !isInlineEditable(meta)) return;
      setPicker(null);
      setEditor({ colIdx, rowIdx, rid: r.rid, value: r.cells[meta.id] ?? null, anchor });
    },
    [columns, getRow],
  );

  const onCellClicked = useCallback(
    (cell: Item, event: CellClickedEventArgs) => {
      const meta = columns[cell[0]];
      const rowIdx = cell[1];
      const r = getRow(rowIdx);
      if (!meta || !r) return;
      // event.bounds is in client (viewport) coordinates already.
      const b = event.bounds;
      const anchor: Anchor = { x: b.x, y: b.y, width: b.width, height: b.height };
      if (hasPopupEditor(meta)) {
        setEditor(null);
        setPicker({ col: meta, rowIdx, anchor });
        return;
      }
      // Notion-style: a single click puts the cell straight into edit mode so
      // typing (including CJK via IME) lands in a real <input>.
      if (!shiftHeld.current && isInlineEditable(meta)) {
        openInlineEditor(cell[0], rowIdx, anchor);
      }
    },
    [columns, getRow, openInlineEditor],
  );

  // Enter (and double-click) on a selected cell also starts editing.
  const onCellActivated = useCallback(
    (cell: Item) => {
      const anchor = anchorFor(cell[0], cell[1]);
      if (!anchor) return;
      openInlineEditor(cell[0], cell[1], anchor);
    },
    [anchorFor, openInlineEditor],
  );

  const closeEditor = useCallback(() => {
    setEditor(null);
    // Hand keyboard control back to the grid once editing ends.
    gridRef.current?.focus();
  }, []);

  const moveEditor = useCallback(
    (dir: -1 | 1) => {
      if (!editor) return;
      let idx = editor.colIdx + dir;
      while (idx >= 0 && idx < columns.length && !isInlineEditable(columns[idx])) idx += dir;
      if (idx < 0 || idx >= columns.length) {
        closeEditor();
        return;
      }
      const anchor = anchorFor(idx, editor.rowIdx);
      const meta = columns[idx];
      const r = getRow(editor.rowIdx);
      if (!anchor || !meta || !r) {
        closeEditor();
        return;
      }
      setEditor({
        colIdx: idx,
        rowIdx: editor.rowIdx,
        rid: r.rid,
        value: r.cells[meta.id] ?? null,
        anchor,
      });
    },
    [columns, editor, getRow, anchorFor, closeEditor],
  );

  const onHeaderContextMenu = useCallback(
    (colIndex: number, event: HeaderClickedEventArgs) => {
      event.preventDefault();
      const meta = columns[colIndex];
      if (!meta) return;
      const b = event.bounds;
      setColMenu({
        col: meta,
        x: b.x,
        y: b.y + b.height,
      });
    },
    [columns],
  );

  // Glide's header caret (`hasMenu: true`) fires this instead of a context
  // menu; route it to the same column menu so the affordance is not inert.
  const onHeaderMenuClick = useCallback(
    (colIndex: number, bounds: Rectangle) => {
      const meta = columns[colIndex];
      if (!meta) return;
      setEditor(null);
      setPicker(null);
      setColMenu({ col: meta, x: bounds.x, y: bounds.y + bounds.height });
    },
    [columns],
  );

  // Clicking the leading glyph (emoji or default type icon) edits the emoji.
  // The glyph occupies the first ~28px; the title starts right after it.
  const onHeaderClicked = useCallback(
    (colIndex: number, event: HeaderClickedEventArgs) => {
      if (colIndex >= columns.length) {
        // The trailing "+" header cell is the add-column entry.
        event.preventDefault();
        setEditor(null);
        setPicker(null);
        setColDialog({ existing: null });
        return;
      }
      const meta = columns[colIndex];
      if (!meta || event.localEventX > 28) return;
      event.preventDefault();
      setEditor(null);
      setPicker(null);
      const b = event.bounds;
      setHeaderEmoji({ col: meta, x: b.x + 8, y: b.y + b.height });
    },
    [columns],
  );

  /** Move a column one visible slot left/right (header-menu fallback). */
  const moveColumn = useCallback(
    (colId: string, dir: -1 | 1) => {
      if (!activeViewId) return;
      const idx = columns.findIndex((c) => c.id === colId);
      if (idx < 0) return;
      const neighbor = columns[idx + dir];
      if (!neighbor) return;
      const target = layout.findIndex((v) => v.column_id === neighbor.id);
      if (target >= 0) void updateViewColumn(activeViewId, colId, { position: target });
    },
    [columns, layout, activeViewId, updateViewColumn],
  );

  /** Drag-to-reorder: map the visible drop index onto the view's own layout. */
  const onColumnMoved = useCallback(
    (startIndex: number, endIndex: number) => {
      if (!activeViewId) return;
      const moved = columns[startIndex];
      const anchor = columns[Math.min(endIndex, columns.length - 1)];
      if (!moved || !anchor) return;
      const target = layout.findIndex((v) => v.column_id === anchor.id);
      if (target >= 0) void updateViewColumn(activeViewId, moved.id, { position: target });
    },
    [columns, layout, activeViewId, updateViewColumn],
  );

  const selectedRids = useMemo(() => {
    const out: string[] = [];
    for (const i of gridSelection.rows) {
      const r = rowsCache.get(i);
      if (r) out.push(r.rid);
    }
    return out;
  }, [gridSelection, rowsCache, rowsVersion]);

  const colMenuIndex = colMenu ? columns.findIndex((c) => c.id === colMenu.col.id) : -1;

  if (!table || !activeTableId) {
    return (
      <div className="empty-state">
        <div className="empty-card">
          <span className="empty-icon">
            <IconTable size={26} />
          </span>
          <p>{t("table.empty")}</p>
        </div>
      </div>
    );
  }

  const pickerRow = picker ? getRow(picker.rowIdx) : undefined;
  const editorCol = editor ? columns[editor.colIdx] : undefined;

  return (
    <div className="table-view">
      <div className="toolbar">
        <div className="toolbar-title-group">
          <EmojiMenu
            value={table.icon}
            onChange={(icon) => void setTableIcon(table.id, icon)}
            trigger={
              <button
                type="button"
                className="table-icon-btn"
                aria-label={t("table.icon")}
                title={t("table.icon")}
              >
                {table.icon ? (
                  <span className="table-emoji">{table.icon}</span>
                ) : (
                  <IconTable size={15} />
                )}
              </button>
            }
          />
          <h2 className="toolbar-title">{table.name}</h2>
          <span className="pill-count">{t("table.rows", { count: total })}</span>
          {searchQuery && <span className="pill-filter">{t("table.searching", { query: searchQuery })}</span>}
        </div>
        <div className="toolbar-spacer" />
        <label className="search-field">
          <IconSearch size={14} />
          <input
            type="text"
            placeholder={t("table.searchPlaceholder")}
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
          {localQuery && (
            <button
              type="button"
              className="search-clear"
              aria-label={t("table.clearSearch")}
              onClick={() => {
                setLocalQuery("");
                void searchRows("");
              }}
            >
              <IconX size={12} />
            </button>
          )}
        </label>
        {activeView?.kind === "grid" && (
          <button className="btn ghost" onClick={() => setPanelOpen(true)}>
            <IconSliders size={14} /> {t("table.filterSort")}
          </button>
        )}
        <button className="btn ghost" onClick={() => setColDialog({ existing: null })}>
          <IconPlus size={14} /> {t("table.addColumn")}
        </button>
        <button className="btn primary" onClick={() => void insertRow({})}>
          <IconPlus size={14} /> {t("table.addRow")}
        </button>
        <button
          className="btn"
          disabled={selectedRids.length === 0}
          title={t("table.duplicateRowsHint")}
          onClick={() =>
            void duplicateRows(selectedRids).then(() => {
              // Copies land at the end (rows are ULID-ordered); bring the last
              // one into view so the action has visible feedback.
              const { total } = useWorkspace.getState();
              if (total > 0) gridRef.current?.scrollTo(0, total - 1, "vertical");
            })
          }
        >
          <IconCopy size={14} />{" "}
          {selectedRids.length > 0
            ? t("table.duplicateRows", { count: selectedRids.length })
            : t("table.duplicateRow")}
        </button>
        <button
          className="btn danger-ghost"
          disabled={selectedRids.length === 0}
          title={t("table.deleteRowsHint")}
          onClick={() => {
            const count = selectedRids.length;
            void confirm({
              title: t("table.deleteRowsTitle"),
              description: t("table.deleteRowsConfirm", { count }),
              confirmLabel: t("common.delete"),
              danger: true,
            }).then((ok) => {
              if (ok) void deleteRows(selectedRids);
            });
          }}
        >
          <IconTrash size={14} />{" "}
          {selectedRids.length > 0
            ? t("table.deleteRows", { count: selectedRids.length })
            : t("common.delete")}
        </button>
      </div>
      {activeView?.kind === "grid" && (
        <ViewConfigBar
          key={activeView.id}
          view={activeView}
          columns={columns}
          onEdit={() => setPanelOpen(true)}
        />
      )}
      <div className="grid-wrap">
        <DataEditor
          ref={gridRef}
          columns={gridColumns}
          rows={total}
          theme={gridTheme}
          getCellContent={getCellContent}
          onCellEdited={onCellEdited}
          onCellClicked={onCellClicked}
          onCellActivated={onCellActivated}
          onHeaderClicked={onHeaderClicked}
          onHeaderContextMenu={onHeaderContextMenu}
          onHeaderMenuClick={onHeaderMenuClick}
          onVisibleRegionChanged={onVisibleRegionChanged}
          rowMarkers={{ kind: "both" }}
          gridSelection={gridSelection}
          onGridSelectionChange={setGridSelection}
          trailingRowOptions={{ tint: true, sticky: true, hint: t("table.newRowHint") }}
          onRowAppended={() => {
            void insertRow({});
          }}
          onColumnResize={(column, newSize) => {
            if (column.id === ADD_COLUMN_ID) return;
            if (column.id && activeViewId) {
              void updateViewColumn(activeViewId, column.id, { width: newSize });
            }
          }}
          onColumnMoved={onColumnMoved}
          smoothScrollX={true}
          smoothScrollY={true}
          getCellsForSelection={true}
          rangeSelect="rect"
          columnSelect="none"
        />
      </div>

      {/* ---- floating cell editor (text / number / date) ---- */}
      {editor && editorCol && (
        <InlineCellEditor
          key={`${editorCol.id}:${editor.rowIdx}`}
          request={{
            col: editorCol,
            rowIdx: editor.rowIdx,
            rid: editor.rid,
            anchor: editor.anchor,
            value: editor.value,
          }}
          onCommit={(v) => void updateCell(editor.rid, editorCol.id, v)}
          onClose={closeEditor}
          onMove={moveEditor}
        />
      )}

      {/* ---- popups ---- */}
      {picker && pickerRow && colType(picker.col) !== "relation" && (
        <SelectPopover
          col={picker.col}
          value={pickerRow.cells[picker.col.id] ?? null}
          anchor={picker.anchor}
          onCommit={(v) => void updateCell(pickerRow.rid, picker.col.id, v)}
          onClose={() => setPicker(null)}
          onEditOptions={() => {
            setPicker(null);
            setColDialog({ existing: picker.col });
          }}
        />
      )}
      {picker && pickerRow && colType(picker.col) === "relation" && (
        <RelationModal
          col={picker.col}
          value={Array.isArray(pickerRow.cells[picker.col.id])
            ? (pickerRow.cells[picker.col.id] as Json[]).map(String)
            : []}
          onCommit={(rids) => void updateCell(pickerRow.rid, picker.col.id, rids)}
          onClose={() => setPicker(null)}
        />
      )}

      {headerEmoji && (
        <EmojiMenu
          open
          value={headerEmoji.col.icon}
          onChange={(icon) => void updateColumn(headerEmoji.col.id, { icon: icon ?? "" })}
          onOpenChange={(open) => {
            if (!open) setHeaderEmoji(null);
          }}
          trigger={
            <span
              className="virtual-anchor"
              style={{ left: headerEmoji.x, top: headerEmoji.y }}
              aria-hidden
            />
          }
        />
      )}

      {colMenu && (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) setColMenu(null);
          }}
          trigger={
            <span
              className="virtual-anchor"
              style={{ left: colMenu.x, top: colMenu.y }}
              aria-hidden
            />
          }
        >
          <MenuItem
            onSelect={() => {
              setColDialog({ existing: colMenu.col });
              setColMenu(null);
            }}
          >
            <IconPencil size={14} /> {t("table.editColumn")}
          </MenuItem>
          <MenuItem
            disabled={colMenuIndex <= 0}
            onSelect={() => {
              moveColumn(colMenu.col.id, -1);
              setColMenu(null);
            }}
          >
            {t("table.moveColumnLeft")}
          </MenuItem>
          <MenuItem
            disabled={colMenuIndex < 0 || colMenuIndex >= columns.length - 1}
            onSelect={() => {
              moveColumn(colMenu.col.id, 1);
              setColMenu(null);
            }}
          >
            {t("table.moveColumnRight")}
          </MenuItem>
          {colType(colMenu.col) === "text" &&
            !isReverse(colMenu.col) &&
            table.title_col_id !== colMenu.col.id && (
              <MenuItem
                onSelect={() => {
                  void setTitleColumn(colMenu.col.id);
                  setColMenu(null);
                }}
              >
                <IconStar size={14} /> {t("table.setTitleColumn")}
              </MenuItem>
            )}
          <MenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(`${table.sql_name}.${sqlNameOf(colMenu.col)}`);
              setColMenu(null);
            }}
          >
            <IconCopy size={14} /> {t("table.copySqlRef")}
          </MenuItem>
          {!isReverse(colMenu.col) && table.title_col_id !== colMenu.col.id && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  const c = colMenu.col;
                  setColMenu(null);
                  void confirm({
                    title: t("column.deleteTitle"),
                    description: t("column.deleteConfirm", { name: c.name }),
                    confirmLabel: t("common.delete"),
                    danger: true,
                  }).then((ok) => {
                    if (ok) void deleteColumn(c.id);
                  });
                }}
              >
                <IconTrash size={14} /> {t("table.deleteColumn")}
              </MenuItem>
            </>
          )}
        </Menu>
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