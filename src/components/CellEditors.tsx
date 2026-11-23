// Popup editors for cell types that need richer UI than glide's built-in
// overlays: select / multi_select (popover at the cell) and relation
// (searchable picker against the target table's title column).
//
// Both use `src/ui/` primitives. A 1×1 virtual anchor is placed at the cell's
// rectangle so the primitive can position itself — the grid is canvas, so
// there is no DOM node to anchor to.

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import { t } from "../i18n";
import type { ColumnMeta, Json, Row } from "../types";
import { choicesOf } from "../types";
import { chipStyle } from "../theme/grid";
import { Dialog } from "../ui/Dialog";
import { IconCheck, IconLink, IconPencil, IconSearch, IconX } from "./icons";

export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Select / multi-select popover
// ---------------------------------------------------------------------------

export function SelectPopover({
  col,
  value,
  anchor,
  onCommit,
  onClose,
  onEditOptions,
}: {
  col: ColumnMeta;
  value: Json;
  anchor: Anchor;
  onCommit: (v: Json) => void;
  onClose: () => void;
  /** Opens the column editor on this column (option icon/color live there). */
  onEditOptions?: () => void;
}) {
  const multi = col.data.kind === "multi_select";
  const choices = choicesOf(col);
  const selected: string[] = multi
    ? Array.isArray(value)
      ? (value as Json[]).map(String)
      : []
    : typeof value === "string" && value !== ""
      ? [value]
      : [];
  const [local, setLocal] = useState<string[]>(selected);

  const toggle = (name: string) => {
    if (!multi) {
      onCommit(name);
      onClose();
      return;
    }
    const next = local.includes(name) ? local.filter((n) => n !== name) : [...local, name];
    setLocal(next);
    onCommit(next); // commit live so the grid stays in sync
  };

  return (
    <Popover.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Popover.Trigger asChild>
        <span
          className="virtual-anchor"
          style={{ left: anchor.x, top: anchor.y + anchor.height }}
          aria-hidden
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover"
          side="bottom"
          align="start"
          sideOffset={4}
          style={{ minWidth: Math.max(180, anchor.width) }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="popover-head">
            <span>{multi ? t("cell.multi") : t("cell.single")}</span>
            <button className="btn-icon" onClick={onClose} aria-label={t("common.close")}>
              <IconX size={12} />
            </button>
          </div>
          {choices.length === 0 && <div className="popover-empty">{t("cell.noChoices")}</div>}
          {choices.map((c) => {
            const on = local.includes(c.name);
            return (
              <div
                key={c.id}
                className={on ? "popover-item selected" : "popover-item"}
                onClick={() => toggle(c.name)}
              >
                <span className="popover-check">{on ? <IconCheck size={13} /> : null}</span>
                {c.icon && <span className="popover-icon">{c.icon}</span>}
                <span
                  className="popover-tag"
                  style={c.color ? chipStyle(c.color) : undefined}
                >
                  {c.name}
                </span>
              </div>
            );
          })}
          {!multi && (
            <>
              <div className="popover-sep" />
              <div
                className="popover-item clear"
                onClick={() => {
                  onCommit(null);
                  onClose();
                }}
              >
                {t("cell.clear")}
              </div>
            </>
          )}
          {onEditOptions && (
            <>
              <div className="popover-sep" />
              <div
                className="popover-item"
                onClick={() => {
                  onClose();
                  onEditOptions();
                }}
              >
                <span className="popover-check">
                  <IconPencil size={12} />
                </span>
                {t("column.editOptions")}
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Relation picker modal
// ---------------------------------------------------------------------------

export function RelationModal({
  col,
  value,
  onCommit,
  onClose,
}: {
  col: ColumnMeta;
  value: string[];
  onCommit: (rids: string[]) => void;
  onClose: () => void;
}) {
  const tables = useWorkspace((s) => s.tables);
  const opts = col.data.kind === "relation" ? col.data : null;
  const targetTable = tables.find((x) => x.id === opts?.target_table_id) ?? null;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Row[]>([]);
  const [titleColId, setTitleColId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(value);
  const [loading, setLoading] = useState(false);

  const single = opts?.single ?? false;

  // Resolve the target table's title column once.
  useEffect(() => {
    if (!targetTable) return;
    setTitleColId(targetTable.title_col_id);
  }, [targetTable]);

  const runQuery = useMemo(
    () => async (q: string) => {
      if (!targetTable) return;
      setLoading(true);
      try {
        const page = q.trim()
          ? await ipc.search(targetTable.id, q.trim(), 50, 0)
          : await ipc.rowList(targetTable.id, 50, 0);
        setResults(page.rows);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [targetTable],
  );

  useEffect(() => {
    void runQuery("");
  }, [runQuery]);

  useEffect(() => {
    const timer = setTimeout(() => void runQuery(query), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const titleOf = (row: Row): string => {
    if (titleColId && row.cells[titleColId] != null) return String(row.cells[titleColId]);
    return `(${row.rid.slice(-6)})`;
  };

  const toggle = (rid: string) => {
    if (single) {
      setSelected(selected.includes(rid) ? [] : [rid]);
    } else {
      setSelected(selected.includes(rid) ? selected.filter((r) => r !== rid) : [...selected, rid]);
    }
  };

  return (
    <Dialog
      title={
        targetTable
          ? t("cell.relationTitle", { name: targetTable.name })
          : t("cell.relationFallback")
      }
      subtitle={single ? t("cell.relationSingle") : t("cell.relationMulti")}
      onClose={onClose}
    >
      <label className="search-field">
        <IconSearch size={14} />
        <input
          type="text"
          autoFocus
          placeholder={t("cell.searchByTitle")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="relation-results">
        {loading && <div className="popover-empty">{t("cell.searching")}</div>}
        {!loading && results.length === 0 && (
          <div className="popover-empty">{t("cell.noMatches")}</div>
        )}
        {results.map((row) => {
          const isSelected = selected.includes(row.rid);
          return (
            <div
              key={row.rid}
              className={isSelected ? "popover-item selected" : "popover-item"}
              onClick={() => toggle(row.rid)}
            >
              <span className="popover-check">{isSelected ? <IconCheck size={13} /> : null}</span>
              {titleOf(row)}
            </div>
          );
        })}
      </div>
      <div className="relation-selected">
        <span className="relation-selected-label">
          <IconLink size={13} />
          {t("cell.selectedCount", { count: selected.length })}
        </span>
        {!single && selected.length > 0 && (
          <button className="btn ghost small" onClick={() => setSelected([])}>
            {t("cell.clearAll")}
          </button>
        )}
      </div>
      <div className="modal-actions">
        <div className="toolbar-spacer" />
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          className="btn primary"
          onClick={() => {
            onCommit(selected);
            onClose();
          }}
        >
          {t("common.confirm")}
        </button>
      </div>
    </Dialog>
  );
}