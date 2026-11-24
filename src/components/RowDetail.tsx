// Full-row editor, opened from the grid's cell menu.
//
// The panel renders every column (including hidden ones) in table order. Text,
// number, date and checkbox fields edit in place; select/relation reuse the same
// popups as the grid so there is one behavior to maintain. Formula columns and
// reverse relations are read-only.
//
// Writes go through the workspace store (`updateCell`), which means they are
// recorded on the workspace undo stack automatically.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import { t } from "../i18n";
import { formatDate, formatNumber } from "../i18n/format";
import type {
  ColumnMeta,
  Json,
  Row,
  RowDetail as RowDetailData,
} from "../types";
import { choicesOf, colType, formulaResultType, isReverse } from "../types";
import { PanelDialog } from "../ui/Dialog";
import { Checkbox, Input, Textarea } from "../ui/Field";
import { chipDot, chipStyle } from "../theme/grid";
import { anchorAt, RelationModal, SelectPopover, type Anchor } from "./CellEditors";

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="detail-field">
      <span className="field-label">{label}</span>
      <div className="detail-control">{children}</div>
      {hint && <span className="ui-hint">{hint}</span>}
    </div>
  );
}

function rawText(value: Json | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ReadonlyValue({ col, value }: { col: ColumnMeta; value: Json | undefined }) {
  const type = colType(col);
  const result = formulaResultType(col);
  let text: string;
  if (type === "checkbox" || result === "checkbox") {
    text = value === true ? "✓" : "";
  } else if (type === "number" || result === "number") {
    text = formatNumber(value, col.format);
  } else if (type === "date" || result === "date") {
    text = formatDate(value, col.format);
  } else {
    text = rawText(value);
  }
  return text ? (
    <span className="detail-readonly">{text}</span>
  ) : (
    <span className="detail-empty">{t("rowDetail.empty")}</span>
  );
}

/** Controlled text input that commits on blur (and Ctrl/Cmd+Enter). */
function TextField({
  value,
  multiline,
  onCommit,
}: {
  value: Json | undefined;
  multiline: boolean;
  onCommit: (next: Json) => void;
}) {
  const initial = rawText(value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = () => {
    if (text === initial) return;
    onCommit(text === "" ? null : text);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      commit();
      (e.target as HTMLElement).blur();
    }
  };
  return multiline ? (
    <Textarea
      rows={2}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  ) : (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

/** Number field: empty clears, non-numeric input is not committed. */
function NumberField({
  value,
  onCommit,
}: {
  value: Json | undefined;
  onCommit: (next: Json) => void;
}) {
  const initial = value === null || value === undefined ? "" : String(value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = () => {
    if (text === initial) return;
    if (text.trim() === "") return onCommit(null);
    const n = Number(text);
    if (Number.isFinite(n)) onCommit(n);
  };
  return (
    <Input
      type="number"
      step="any"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        commit();
        (e.target as HTMLElement).blur();
      }}
    />
  );
}

function DateField({
  value,
  onCommit,
}: {
  value: Json | undefined;
  onCommit: (next: Json) => void;
}) {
  const initial = typeof value === "string" ? value.slice(0, 10) : "";
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = () => {
    if (text === initial) return;
    onCommit(text === "" ? null : text);
  };
  return (
    <Input
      type="date"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  );
}

function OptionChips({
  col,
  value,
}: {
  col: ColumnMeta;
  value: Json | undefined;
}) {
  const names =
    colType(col) === "multi_select"
      ? Array.isArray(value)
        ? (value as Json[]).map(String)
        : []
      : typeof value === "string" && value !== ""
        ? [value]
        : [];
  if (names.length === 0) return <span className="detail-empty">{t("rowDetail.empty")}</span>;
  return (
    <>
      {names.map((name) => {
        const choice = choicesOf(col).find((c) => c.name === name);
        return (
          <span
            key={name}
            className="detail-chip"
            style={choice?.color ? chipStyle(choice.color) : undefined}
          >
            {choice?.icon ? (
              <span>{choice.icon}</span>
            ) : (
              <span
                className="chip-dot"
                style={{ background: chipDot(choice?.color ?? null) }}
              />
            )}
            {name}
          </span>
        );
      })}
    </>
  );
}

function RelationChips({
  value,
  titles,
}: {
  value: Json | undefined;
  titles: Record<string, string>;
}) {
  const rids = Array.isArray(value) ? (value as Json[]).map(String) : [];
  if (rids.length === 0) return <span className="detail-empty">{t("rowDetail.empty")}</span>;
  return (
    <>
      {rids.map((rid) => (
        <span key={rid} className="detail-chip ghost" title={rid}>
          {titles[rid] || rid}
        </span>
      ))}
    </>
  );
}

export default function RowDetail({
  tableId,
  rid,
  onClose,
}: {
  tableId: string;
  rid: string;
  onClose: () => void;
}) {
  const columns = useWorkspace((s) => s.columns);
  const tables = useWorkspace((s) => s.tables);
  const updateCell = useWorkspace((s) => s.updateCell);

  const [detail, setDetail] = useState<RowDetailData | null>(null);
  const [row, setRow] = useState<Row | null>(null);
  const [missing, setMissing] = useState(false);
  const [picker, setPicker] = useState<{ col: ColumnMeta; anchor: Anchor } | null>(null);
  const [relationCol, setRelationCol] = useState<ColumnMeta | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await ipc.rowDetail(tableId, rid);
      setDetail(next);
      setRow(next.row);
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [tableId, rid]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const orderedColumns = useMemo(
    () => columns.slice().sort((a, b) => a.position - b.position),
    [columns],
  );
  const table = tables.find((x) => x.id === tableId) ?? null;
  const titleColumn =
    orderedColumns.find((c) => c.id === table?.title_col_id) ?? orderedColumns[0] ?? null;
  const title = titleColumn ? rawText(row?.cells[titleColumn.id]) : "";

  const commit = useCallback(
    async (col: ColumnMeta, value: Json, refreshTitles = false) => {
      const updated = await updateCell(rid, col.id, value);
      if (updated) setRow(updated);
      if (refreshTitles) await reload();
    },
    [updateCell, rid, reload],
  );

  const openPicker = (col: ColumnMeta, el: HTMLElement) => {
    setPicker({ col, anchor: anchorAt(el.getBoundingClientRect()) });
  };

  const renderField = (col: ColumnMeta) => {
    if (isReverse(col)) {
      return (
        <FieldRow key={col.id} label={col.name} hint={t("rowDetail.reverseReadonly")}>
          <RelationChips value={row?.cells[col.id]} titles={detail?.titles ?? {}} />
        </FieldRow>
      );
    }
    const type = colType(col);
    if (type === "formula") {
      return (
        <FieldRow key={col.id} label={col.name}>
          <ReadonlyValue col={col} value={row?.cells[col.id]} />
        </FieldRow>
      );
    }
    const value = row?.cells[col.id];
    switch (type) {
      case "checkbox":
        return (
          <div className="detail-field" key={col.id}>
            <span className="field-label">{col.name}</span>
            <div className="detail-control">
              <Checkbox
                checked={value === true}
                onChange={(checked) => void commit(col, checked)}
              >
                {value === true ? "✓" : t("rowDetail.empty")}
              </Checkbox>
            </div>
          </div>
        );
      case "number":
        return (
          <FieldRow key={col.id} label={col.name}>
            <NumberField value={value} onCommit={(next) => void commit(col, next)} />
          </FieldRow>
        );
      case "date":
        return (
          <FieldRow key={col.id} label={col.name}>
            <DateField value={value} onCommit={(next) => void commit(col, next)} />
          </FieldRow>
        );
      case "select":
      case "multi_select":
        return (
          <FieldRow key={col.id} label={col.name}>
            <div className="detail-chips">
              <OptionChips col={col} value={value} />
              <button
                type="button"
                className="btn small"
                onClick={(e) => openPicker(col, e.currentTarget)}
              >
                {t("common.choose")}
              </button>
            </div>
          </FieldRow>
        );
      case "relation":
        return (
          <FieldRow key={col.id} label={col.name}>
            <div className="detail-chips">
              <RelationChips value={value} titles={detail?.titles ?? {}} />
              <button
                type="button"
                className="btn small"
                onClick={() => setRelationCol(col)}
              >
                {t("common.choose")}
              </button>
            </div>
          </FieldRow>
        );
      case "text":
      default:
        return (
          <FieldRow key={col.id} label={col.name}>
            <TextField
              value={value}
              multiline
              onCommit={(next) => void commit(col, next)}
            />
          </FieldRow>
        );
    }
  };

  return (
    <PanelDialog
      title={title || t("rowDetail.noTitle")}
      badge={
        <span className="panel-head-view">
          {table?.name ? `${table.name} · ` : ""}
          {t("rowDetail.title")}
        </span>
      }
      side
      onClose={onClose}
    >
      {missing ? (
        <p className="detail-empty">{t("rowDetail.deleted")}</p>
      ) : !row ? (
        <p className="detail-empty">{t("common.loading")}</p>
      ) : (
        <div className="row-detail">
          {orderedColumns.map(renderField)}
          <div className="detail-meta">
            <span>{t("rowDetail.metaCreated", { time: formatDate(row.created) })}</span>
            <span>{t("rowDetail.metaUpdated", { time: formatDate(row.updated) })}</span>
          </div>
        </div>
      )}

      {picker && (
        <SelectPopover
          col={picker.col}
          value={row?.cells[picker.col.id] ?? null}
          anchor={picker.anchor}
          onCommit={(v) => void commit(picker.col, v)}
          onClose={() => setPicker(null)}
        />
      )}

      {relationCol && (
        <RelationModal
          col={relationCol}
          value={
            Array.isArray(row?.cells[relationCol.id])
              ? (row?.cells[relationCol.id] as Json[]).map(String)
              : []
          }
          onCommit={(rids) => {
            void commit(relationCol, rids, true);
            setRelationCol(null);
          }}
          onClose={() => setRelationCol(null)}
        />
      )}
    </PanelDialog>
  );
}