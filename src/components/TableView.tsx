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
import { readGridTheme, readOptionPalette, tagThemeOverride } from "../theme/grid";
import { formatDate } from "../i18n/format";
import { t } from "../i18n";
import { confirm } from "../ui/ConfirmDialog";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { toast } from "../stores/toast";
import type { Cells, ColumnMeta, Json, Row } from "../types";
import { choicesOf, colType, formulaResultType, isReverse, sqlNameOf } from "../types";
import { createOptionCellRenderer, optionCellFor } from "./OptionCell";
import FilterSortPanel from "./FilterSortPanel";
import ViewConfigBar from "./ViewConfigBar";
import ColumnDialog from "./ColumnDialogs";
import { RelationModal, SelectPopover, type Anchor } from "./CellEditors";
import { InlineCellEditor, type EditorMove } from "./GridEditors";
import StartActions from "./StartActions";
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
    case "select":
      return optionCellFor(col, value, contentAlign);
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

/** `YYYY-MM-DD` from the shapes spreadsheets actually produce. */
function normalizePasteDate(raw: string): string | undefined {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const ymd = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(raw);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return undefined;
}

/** Pick a choice by exact name first, then case-insensitively. */
function matchChoice(col: ColumnMeta, name: string) {
  const choices = choicesOf(col);
  return (
    choices.find((c) => c.name === name) ??
    choices.find((c) => c.name.toLowerCase() === name.toLowerCase())
  );
}

/**
 * Parse one pasted string into a cell value for `col`.
 * `undefined` means "cannot represent this as the column type" — the caller
 * skips the cell and counts it, instead of writing a wrong value.
 */
export function parsePasteValue(col: ColumnMeta, raw: string): Json | undefined {
  const text = raw.replace(/\r/g, "");
  switch (colType(col)) {
    case "number": {
      const s = text.trim();
      if (s === "") return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    }
    case "checkbox": {
      const s = text.trim().toLowerCase();
      if (s === "" || ["false", "0", "no", "n", "否", "☐"].includes(s)) return false;
      if (["true", "1", "yes", "y", "是", "✓", "✔", "☑"].includes(s)) return true;
      return undefined;
    }
    case "date": {
      const s = text.trim();
      if (s === "") return null;
      return normalizePasteDate(s);
    }
    case "select": {
      const s = text.trim();
      if (s === "") return null;
      // With no options configured the backend accepts any name.
      if (choicesOf(col).length === 0) return s;
      return matchChoice(col, s)?.name;
    }
    case "multi_select": {
      const s = text.trim();
      if (s === "") return null;
      const parts = s
        .split(/[,，;；、]/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length === 0) return null;
      if (choicesOf(col).length === 0) return parts;
      const names = parts.map((part) => matchChoice(col, part)?.name);
      // A partial match would silently drop labels — reject the whole cell.
      return names.every((n): n is string => !!n) ? names : undefined;
    }
    case "formula":
    case "relation":
      return undefined;
    default:
      return text === "" ? null : text;
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

/** Upper bound on cells a single Delete press will clear (safety valve). */
const MAX_CLEAR_CELLS = 2000;

export default function TableView() {
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const tables = useWorkspace((s) => s.tables);
  const visibleColumns = useWorkspace((s) => s.visibleColumns);
  const allColumns = useWorkspace((s) => s.columns);
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
  const updateCells = useWorkspace((s) => s.updateCells);
  const insertRows = useWorkspace((s) => s.insertRows);
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
  const [cellMenu, setCellMenu] = useState<{
    rowIdx: number;
    colIdx: number;
    x: number;
    y: number;
  } | null>(null);
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
  const scheme = useTheme((s) => s.scheme);
  const gridTheme = useMemo(() => readGridTheme(), [resolvedTheme, scheme]);
  const optionPalette = useMemo(() => readOptionPalette(), [resolvedTheme, scheme]);
  const customRenderers = useMemo(
    () => [createOptionCellRenderer(optionPalette)],
    [optionPalette],
  );
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

  /** Value that means "empty" for a column (checkbox columns are NOT NULL). */
  const emptyValue = useCallback((meta: ColumnMeta): Json => {
    return colType(meta) === "checkbox" ? false : null;
  }, []);

  /**
   * Delete/Backspace on a cell or range. We handle it ourselves instead of
   * letting Glide clear `Text` cells only: select/relation cells need an
   * explicit null, checkbox cells need `false`, and formula/reverse columns
   * must not be touched at all. One batched write per row, one refetch overall.
   *
   * Row-marker selections are intentionally ignored: there is no undo, so a
   * stray Delete must not wipe whole rows (deleting rows stays explicit and
   * confirmed).
   */
  const onDelete = useCallback(
    (selection: GridSelection) => {
      if (!activeTableId) return true;
      const range = selection.current?.range;
      if (!range) return true;

      const rowIdxs: number[] = [];
      for (let y = range.y; y < range.y + range.height; y++) rowIdxs.push(y);
      const colStart = range.x;
      const colEnd = range.x + range.width;

      const updates: { rid: string; cells: Cells }[] = [];
      let cleared = 0;
      for (const rowIdx of rowIdxs) {
        if (cleared >= MAX_CLEAR_CELLS) break;
        const r = getRow(rowIdx);
        if (!r) continue;
        const cells: Cells = {};
        for (let c = Math.max(0, colStart); c < Math.min(columns.length, colEnd); c++) {
          const meta = columns[c];
          if (!meta || colType(meta) === "formula" || isReverse(meta)) continue;
          if (cleared >= MAX_CLEAR_CELLS) break;
          cells[meta.id] = emptyValue(meta);
          cleared += 1;
        }
        if (Object.keys(cells).length > 0) updates.push({ rid: r.rid, cells });
      }
      if (updates.length > 0) void updateCells(updates);
      return true;
    },
    [activeTableId, columns, getRow, updateCells, emptyValue],
  );

  const onCellContextMenu = useCallback(
    (cell: Item, event: CellClickedEventArgs) => {
      event.preventDefault();
      const rowIdx = cell[1];
      if (rowIdx < 0 || rowIdx >= total) return;
      const colIdx = cell[0] >= 0 && cell[0] < columns.length ? cell[0] : 0;
      setEditor(null);
      setPicker(null);
      // Right-click also parks the selection on the clicked cell.
      if (columns.length > 0) {
        setGridSelection({
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
          current: {
            cell: [colIdx, rowIdx],
            range: { x: colIdx, y: rowIdx, width: 1, height: 1 },
            rangeStack: [],
          },
        });
      }
      setCellMenu({
        rowIdx,
        colIdx,
        x: event.bounds.x + 12,
        y: event.bounds.y + event.bounds.height,
      });
    },
    [columns.length, total],
  );

  /** Duplicate rows and scroll the first copy into view (visible feedback). */
  const duplicateAndReveal = useCallback(
    (rids: string[]) => {
      if (rids.length === 0) return;
      void duplicateRows(rids).then(() => {
        const { total: nextTotal } = useWorkspace.getState();
        if (nextTotal > 0) gridRef.current?.scrollTo(0, nextTotal - 1, "vertical");
      });
    },
    [duplicateRows],
  );

  /**
   * TSV paste from a spreadsheet. Text lands in the grid as typed, the rest is
   * coerced per column; cells that cannot be represented are skipped and
   * counted rather than written as garbage. Rows past the end are appended.
   */
  const onPaste = useCallback(
    (target: Item, values: readonly (readonly string[])[]) => {
      if (!activeTableId || values.length === 0) return false;
      const [startCol, startRow] = target;
      if (startCol < 0 || startRow < 0) return false;

      const updates: { rid: string; cells: Cells }[] = [];
      const appended: Cells[] = [];
      let pasted = 0;
      let skipped = 0;

      values.forEach((rowValues, r) => {
        const rowIdx = startRow + r;
        const row = rowIdx < total ? getRow(rowIdx) : undefined;
        const cells: Cells = {};
        rowValues.forEach((raw, c) => {
          const meta = columns[startCol + c];
          if (
            !meta ||
            colType(meta) === "formula" ||
            colType(meta) === "relation" ||
            isReverse(meta)
          ) {
            skipped += 1;
            return;
          }
          const value = parsePasteValue(meta, raw);
          if (value === undefined) {
            skipped += 1;
            return;
          }
          cells[meta.id] = value;
        });
        const count = Object.keys(cells).length;
        if (count === 0) return;
        if (rowIdx >= total) {
          appended.push(cells);
          pasted += count;
        } else if (row) {
          updates.push({ rid: row.rid, cells });
          pasted += count;
        } else {
          // Outside the cached window: we cannot address the row by rid.
          skipped += count;
        }
      });

      if (pasted === 0 && skipped === 0) return false;
      if (updates.length > 0 || appended.length > 0) {
        void (async () => {
          if (updates.length > 0) await updateCells(updates);
          if (appended.length > 0) await insertRows(appended);
        })();
      }
      if (pasted > 0) toast.success(t("toasts.pastedCells", { count: pasted }));
      if (skipped > 0) toast.info(t("toasts.pastedSkipped", { count: skipped }));
      return true;
    },
    [activeTableId, columns, getRow, total, updateCells, insertRows],
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

  /** Put the single-cell selection on a cell (spreadsheet-style navigation). */
  const selectCell = useCallback(
    (colIdx: number, rowIdx: number) => {
      if (colIdx < 0 || colIdx >= columns.length || rowIdx < 0 || rowIdx >= total) {
        gridRef.current?.focus();
        return;
      }
      const cell: Item = [colIdx, rowIdx];
      setGridSelection({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell,
          range: { x: colIdx, y: rowIdx, width: 1, height: 1 },
          rangeStack: [],
        },
      });
      gridRef.current?.scrollTo(colIdx, rowIdx, "vertical");
      gridRef.current?.focus();
    },
    [columns.length, total],
  );

  const moveEditor = useCallback(
    (dir: EditorMove) => {
      if (!editor) return;
      // Enter/Shift+Enter end editing and move the selection vertically.
      if (dir === "down" || dir === "up") {
        const target = editor.rowIdx + (dir === "down" ? 1 : -1);
        const col = editor.colIdx;
        setEditor(null);
        // At the top/bottom edge the edit still ends, the selection stays put.
        if (target < 0 || target >= total) {
          gridRef.current?.focus();
          return;
        }
        selectCell(col, target);
        return;
      }
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
    [columns, editor, getRow, anchorFor, closeEditor, selectCell, total],
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
          <StartActions className="start-actions row" />
        </div>
      </div>
    );
  }

  const pickerRow = picker ? getRow(picker.rowIdx) : undefined;
  const editorCol = editor ? columns[editor.colIdx] : undefined;
  const cellMenuRow = cellMenu ? getRow(cellMenu.rowIdx) : undefined;
  const cellMenuCol = cellMenu ? columns[cellMenu.colIdx] : undefined;
  const canClearCell =
    !!cellMenuCol && colType(cellMenuCol) !== "formula" && !isReverse(cellMenuCol);

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
          onClick={() => duplicateAndReveal(selectedRids)}
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
          columns={allColumns}
          onOpenPanel={() => setPanelOpen(true)}
        />
      )}
      {total === 0 &&
        columns.length > 0 &&
        !searchQuery &&
        !(activeView?.data.kind === "grid" && activeView.data.filters !== null) && (
          <div className="grid-hint-bar">{t("table.emptyRowsHint")}</div>
        )}
      <div className="grid-wrap">
        <DataEditor
          ref={gridRef}
          columns={gridColumns}
          rows={total}
          theme={gridTheme}
          customRenderers={customRenderers}
          getCellContent={getCellContent}
          onCellEdited={onCellEdited}
          onCellClicked={onCellClicked}
          onCellActivated={onCellActivated}
          onCellContextMenu={onCellContextMenu}
          onDelete={onDelete}
          onPaste={onPaste}
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
        {columns.length === 0 && (
          <div className="grid-empty-overlay">
            <p>{t("table.noColumns")}</p>
            <button className="btn primary" onClick={() => setColDialog({ existing: null })}>
              <IconPlus size={14} /> {t("table.addFirstColumn")}
            </button>
          </div>
        )}
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

      {cellMenu && cellMenuRow && (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) setCellMenu(null);
          }}
          ariaLabel={t("table.cellMenu")}
          trigger={
            <span
              className="virtual-anchor"
              style={{ left: cellMenu.x, top: cellMenu.y }}
              aria-hidden
            />
          }
        >
          <MenuItem
            disabled={!canClearCell}
            onSelect={() => {
              if (cellMenuCol) void updateCell(cellMenuRow.rid, cellMenuCol.id, emptyValue(cellMenuCol));
              setCellMenu(null);
            }}
          >
            <IconX size={14} /> {t("table.clearCell")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              duplicateAndReveal([cellMenuRow.rid]);
              setCellMenu(null);
            }}
          >
            <IconCopy size={14} /> {t("table.copyRow")}
          </MenuItem>
          <MenuItem
            danger
            onSelect={() => {
              const rid = cellMenuRow.rid;
              setCellMenu(null);
              void confirm({
                title: t("table.deleteRow"),
                description: t("table.deleteRowsConfirm", { count: 1 }),
                confirmLabel: t("common.delete"),
                danger: true,
              }).then((ok) => {
                if (ok) void deleteRows([rid]);
              });
            }}
          >
            <IconTrash size={14} /> {t("table.deleteRow")}
          </MenuItem>
        </Menu>
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