// Popup editors for cell types that need richer UI than glide's built-in
// overlays: select / multi_select (dropdown at the cell) and relation
// (searchable picker against the target table's title column).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import type { ColumnMeta, Json, Row } from "../types";

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
}: {
  col: ColumnMeta;
  value: Json;
  anchor: Anchor;
  onCommit: (v: Json) => void;
  onClose: () => void;
}) {
  const multi = col.type === "multi_select";
  const choices =
    col.opts.kind === "select" || col.opts.kind === "multi_select"
      ? col.opts.choices.map((c) => c.name)
      : [];
  const selected: string[] = multi
    ? Array.isArray(value)
      ? (value as Json[]).map(String)
      : []
    : typeof value === "string" && value !== ""
      ? [value]
      : [];
  const [local, setLocal] = useState<string[]>(selected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onMouse = (e: MouseEvent) => {
      const el = document.getElementById("select-popover");
      if (el && !el.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouse);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouse);
    };
  }, [onClose]);

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

  const style: CSSProperties = {
    position: "fixed",
    left: Math.max(8, anchor.x),
    top: anchor.y + anchor.height + 2,
    minWidth: Math.max(160, anchor.width),
    zIndex: 300,
  };

  return (
    <div className="popover" id="select-popover" style={style}>
      {multi && (
        <div className="popover-head">
          <span>多选（点击切换）</span>
          <button className="btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
      )}
      {choices.length === 0 && <div className="popover-empty">该列还没有选项</div>}
      {choices.map((c) => (
        <div
          key={c}
          className={local.includes(c) ? "popover-item selected" : "popover-item"}
          onClick={() => toggle(c)}
        >
          {multi && <span className="popover-check">{local.includes(c) ? "☑" : "☐"}</span>}
          {c}
        </div>
      ))}
      {!multi && (
        <div
          className="popover-item clear"
          onClick={() => {
            onCommit(null);
            onClose();
          }}
        >
          清除
        </div>
      )}
    </div>
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
  const opts = col.opts.kind === "relation" ? col.opts : null;
  const targetTable = tables.find((t) => t.id === opts?.target_table_id) ?? null;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Row[]>([]);
  const [titleColId, setTitleColId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(value);
  const [loading, setLoading] = useState(false);

  const single = opts?.single ?? false;

  // resolve the target table's title column once
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
    const t = setTimeout(() => void runQuery(query), 300);
    return () => clearTimeout(t);
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
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal relation-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            选择{targetTable ? `「${targetTable.name}」` : ""}
            {single ? "（单选）" : "（可多选）"}
          </h3>
          <button className="btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <input
            type="text"
            autoFocus
            placeholder="搜索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <div className="relation-results">
            {loading && <div className="popover-empty">搜索中…</div>}
            {!loading && results.length === 0 && (
              <div className="popover-empty">没有匹配的行</div>
            )}
            {results.map((r) => (
              <div
                key={r.rid}
                className={selected.includes(r.rid) ? "popover-item selected" : "popover-item"}
                onClick={() => toggle(r.rid)}
              >
                <span className="popover-check">
                  {selected.includes(r.rid) ? (single ? "◉" : "☑") : single ? "○" : "☐"}
                </span>
                {titleOf(r)}
              </div>
            ))}
          </div>
          {selected.length > 0 && (
            <div className="relation-selected">
              已选 {selected.length} 行
              {!single && (
                <button className="btn-icon" onClick={() => setSelected([])} title="清空">
                  清空
                </button>
              )}
            </div>
          )}
        </div>
        <div className="panel-foot">
          <div className="toolbar-spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onCommit(selected);
              onClose();
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
