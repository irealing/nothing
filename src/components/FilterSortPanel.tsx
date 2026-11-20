// Grid-view config panel: filter tree (and/or groups), sorts and hidden
// columns. Edits a local draft; 保存 persists via view_update and the backend
// recompiles the parameterized SQL.

import { useMemo, useState, type ReactNode } from "react";
import { useWorkspace } from "../stores/workspace";
import type {
  ColumnMeta,
  FilterNode,
  FilterOp,
  FilterRule,
  GridConfig,
  Json,
  ViewMeta,
} from "../types";
import { isFilterGroup } from "../types";

type Kind = "text" | "select" | "multi_select" | "number" | "date" | "checkbox" | "relation";

const OP_LABELS: Record<FilterOp, string> = {
  eq: "等于",
  neq: "不等于",
  contains: "包含",
  not_contains: "不包含",
  starts_with: "开头是",
  ends_with: "结尾是",
  is_empty: "为空",
  is_not_empty: "不为空",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  in: "在列表中",
  not_in: "不在列表中",
  before: "早于",
  after: "晚于",
  on: "当天",
};

const OPS_BY_KIND: Record<Kind, FilterOp[]> = {
  text: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  select: ["eq", "neq", "contains", "is_empty", "is_not_empty", "in", "not_in"],
  multi_select: ["contains", "not_contains", "is_empty", "is_not_empty", "in"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"],
  date: ["before", "after", "on", "eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"],
  checkbox: ["eq", "neq"],
  relation: ["is_empty", "is_not_empty"],
};

const NO_VALUE_OPS: FilterOp[] = ["is_empty", "is_not_empty"];

function effectiveKind(col: ColumnMeta | undefined): Kind {
  if (!col) return "text";
  if (col.type === "formula") {
    const rt = col.opts.kind === "formula" ? col.opts.result_type : "text";
    if (rt === "number") return "number";
    if (rt === "date") return "date";
    if (rt === "checkbox") return "checkbox";
    return "text";
  }
  if (col.type === "relation") return "relation";
  if (col.type === "multi_select") return "multi_select";
  if (col.type === "select") return "select";
  if (col.type === "number") return "number";
  if (col.type === "date") return "date";
  if (col.type === "checkbox") return "checkbox";
  return "text";
}

function choicesOf(col: ColumnMeta | undefined): string[] {
  if (!col) return [];
  if (col.opts.kind === "select" || col.opts.kind === "multi_select") {
    return col.opts.choices.map((c) => c.name);
  }
  return [];
}

// ---- immutable draft helpers -------------------------------------------------

function normalize(cfg: GridConfig): GridConfig {
  // The panel always edits a top-level AND/OR group.
  let filters = cfg.filters;
  if (filters && !isFilterGroup(filters)) {
    filters = { op: "and", children: [filters] };
  }
  return { ...cfg, filters };
}

function clone(node: FilterNode): FilterNode {
  return JSON.parse(JSON.stringify(node)) as FilterNode;
}

function childAtPath(root: FilterNode, path: number[]): FilterNode {
  let cur = root;
  for (const idx of path) {
    if (!isFilterGroup(cur)) throw new Error("bad path");
    cur = cur.children[idx];
  }
  return cur;
}

function prune(node: FilterNode): FilterNode | null {
  if (!isFilterGroup(node)) return node;
  const children = node.children.map(prune).filter((n): n is FilterNode => n !== null);
  if (children.length === 0) return null;
  return { ...node, children };
}

// ---- value editors -----------------------------------------------------------

function ValueInput({
  kind,
  col,
  op,
  value,
  onChange,
}: {
  kind: Kind;
  col: ColumnMeta | undefined;
  op: FilterOp;
  value: Json;
  onChange: (v: Json) => void;
}) {
  if (NO_VALUE_OPS.includes(op)) return null;

  if (op === "in" || op === "not_in") {
    const text = Array.isArray(value) ? (value as Json[]).join(",") : String(value ?? "");
    return (
      <input
        className="filter-value"
        type="text"
        placeholder="逗号分隔多个值"
        value={text}
        onChange={(e) => {
          const parts = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
          onChange(
            kind === "number"
              ? parts.map((p) => Number(p)).filter((n) => !Number.isNaN(n))
              : parts,
          );
        }}
      />
    );
  }

  switch (kind) {
    case "number":
      return (
        <input
          className="filter-value"
          type="number"
          step="any"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <input
          className="filter-value"
          type="date"
          value={typeof value === "string" ? value.slice(0, 10) : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "checkbox":
      return (
        <select
          className="filter-value"
          value={value === true ? "true" : "false"}
          onChange={(e) => onChange(e.target.value === "true")}
        >
          <option value="true">✓ 已勾选</option>
          <option value="false">☐ 未勾选</option>
        </select>
      );
    case "select":
    case "multi_select": {
      const choices = choicesOf(col);
      if (choices.length > 0 && op !== "not_contains") {
        return (
          <select
            className="filter-value"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="" disabled>
              选择…
            </option>
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        );
      }
      return (
        <input
          className="filter-value"
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    default:
      return (
        <input
          className="filter-value"
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder="值"
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

// ---- main panel ----------------------------------------------------------------

export default function FilterSortPanel({ view, onClose }: { view: ViewMeta; onClose: () => void }) {
  const columns = useWorkspace((s) => s.columns);
  const updateView = useWorkspace((s) => s.updateView);

  const initial = useMemo(
    () =>
      normalize(
        view.config.kind === "grid"
          ? view.config
          : { filters: null, sorts: [], hidden_columns: [] },
      ),
    [view],
  );
  const [draft, setDraft] = useState<GridConfig>(initial);

  const colById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const filterable = columns; // relations included (emptiness ops only)

  const setFilters = (f: FilterNode | null) => setDraft((d) => ({ ...d, filters: f }));

  const addRule = (path: number[]) => {
    const col = filterable[0];
    if (!col) return;
    const kind = effectiveKind(col);
    const op = OPS_BY_KIND[kind][0];
    const rule: FilterRule = {
      column_id: col.id,
      op,
      value: kind === "number" ? 0 : kind === "checkbox" ? true : "",
    };
    setDraft((d) => {
      let root = d.filters;
      if (!root) root = { op: "and", children: [] };
      root = clone(root);
      const target = childAtPath(root, path);
      if (isFilterGroup(target)) target.children.push(rule);
      return { ...d, filters: root };
    });
  };

  const addGroup = (path: number[]) => {
    setDraft((d) => {
      let root = d.filters;
      if (!root) root = { op: "and", children: [] };
      root = clone(root);
      const target = childAtPath(root, path);
      if (isFilterGroup(target)) target.children.push({ op: "or", children: [] });
      return { ...d, filters: root };
    });
  };

  const save = async () => {
    const filters = draft.filters ? prune(clone(draft.filters)) : null;
    await updateView(view.id, {
      config: { kind: "grid", filters, sorts: draft.sorts, hidden_columns: draft.hidden_columns },
    });
    onClose();
  };

  const renderNode = (node: FilterNode, path: number[]): ReactNode => {
    if (isFilterGroup(node)) {
      return (
        <div className="filter-group" key={path.join(".")}>
          <div className="filter-group-head">
            <select
              value={node.op}
              onChange={(e) => {
                const next = clone(draft.filters!);
                const g = childAtPath(next, path);
                if (isFilterGroup(g)) g.op = e.target.value as "and" | "or";
                setFilters(next);
              }}
            >
              <option value="and">满足所有（AND）</option>
              <option value="or">满足任一（OR）</option>
            </select>
            <div className="toolbar-spacer" />
            <button className="btn-icon" title="添加条件" onClick={() => addRule(path)}>
              ＋条件
            </button>
            {path.length > 0 && (
              <button className="btn-icon" title="添加分组" onClick={() => addGroup(path)}>
                ＋分组
              </button>
            )}
            {path.length > 0 && (
              <button
                className="btn-icon danger"
                title="删除分组"
                onClick={() => {
                  const next = clone(draft.filters!);
                  const parentPath = path.slice(0, -1);
                  const parent = childAtPath(next, parentPath);
                  if (isFilterGroup(parent)) parent.children.splice(path[path.length - 1], 1);
                  setFilters(next);
                }}
              >
                ✕
              </button>
            )}
          </div>
          <div className="filter-children">
            {node.children.length === 0 && path.length === 0 && (
              <div className="filter-empty">
                没有筛选条件，点「＋条件」开始（不筛选则显示全部行）
              </div>
            )}
            {node.children.map((child, i) => renderNode(child, [...path, i]))}
            {path.length === 0 && (
              <div className="filter-root-adds">
                <button className="btn" onClick={() => addRule([])}>
                  ＋ 条件
                </button>
                <button className="btn" onClick={() => addGroup([])}>
                  ＋ 分组
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    const rule = node;
    const col = colById.get(rule.column_id);
    const kind = effectiveKind(col);
    const ops = OPS_BY_KIND[kind];
    return (
      <div className="filter-rule" key={path.join(".")}>
        <select
          className="filter-col"
          value={rule.column_id}
          onChange={(e) => {
            const nextCol = colById.get(e.target.value);
            const nextKind = effectiveKind(nextCol);
            const nextOp = OPS_BY_KIND[nextKind].includes(rule.op)
              ? rule.op
              : OPS_BY_KIND[nextKind][0];
            const next = clone(draft.filters!);
            const r = childAtPath(next, path);
            if (!isFilterGroup(r)) {
              Object.assign(r, {
                column_id: e.target.value,
                op: nextOp,
                value: nextKind === "number" ? 0 : nextKind === "checkbox" ? true : "",
              });
            }
            setFilters(next);
          }}
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="filter-op"
          value={rule.op}
          onChange={(e) => {
            const next = clone(draft.filters!);
            const r = childAtPath(next, path);
            if (!isFilterGroup(r)) r.op = e.target.value as FilterOp;
            setFilters(next);
          }}
        >
          {ops.map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </select>
        <ValueInput
          kind={kind}
          col={col}
          op={rule.op}
          value={rule.value}
          onChange={(v) => {
            const next = clone(draft.filters!);
            const r = childAtPath(next, path);
            if (!isFilterGroup(r)) r.value = v;
            setFilters(next);
          }}
        />
        <button
          className="btn-icon danger"
          title="删除条件"
          onClick={() => {
            const next = clone(draft.filters!);
            const parentPath = path.slice(0, -1);
            const parent = childAtPath(next, parentPath);
            if (isFilterGroup(parent)) parent.children.splice(path[path.length - 1], 1);
            setFilters(next);
          }}
        >
          ✕
        </button>
      </div>
    );
  };

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h3>筛选与排序 · {view.name}</h3>
          <button className="btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="panel-body">
          <section>
            <h4>筛选</h4>
            {draft.filters ? (
              renderNode(draft.filters, [])
            ) : (
              <div className="filter-empty">
                没有筛选条件
                <div className="filter-root-adds">
                  <button className="btn" onClick={() => addRule([])}>
                    ＋ 条件
                  </button>
                </div>
              </div>
            )}
          </section>

          <section>
            <h4>排序</h4>
            {draft.sorts.map((s, i) => (
              <div className="filter-rule" key={i}>
                <select
                  className="filter-col"
                  value={s.column_id}
                  onChange={(e) => {
                    const sorts = [...draft.sorts];
                    sorts[i] = { ...s, column_id: e.target.value };
                    setDraft((d) => ({ ...d, sorts }));
                  }}
                >
                  {columns
                    .filter((c) => c.type !== "relation")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
                <select
                  className="filter-op"
                  value={s.desc ? "desc" : "asc"}
                  onChange={(e) => {
                    const sorts = [...draft.sorts];
                    sorts[i] = { ...s, desc: e.target.value === "desc" };
                    setDraft((d) => ({ ...d, sorts }));
                  }}
                >
                  <option value="asc">升序</option>
                  <option value="desc">降序</option>
                </select>
                <button
                  className="btn-icon danger"
                  onClick={() =>
                    setDraft((d) => ({ ...d, sorts: d.sorts.filter((_, j) => j !== i) }))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn"
              onClick={() => {
                const first = columns.find((c) => c.type !== "relation");
                if (first) {
                  setDraft((d) => ({
                    ...d,
                    sorts: [...d.sorts, { column_id: first.id, desc: false }],
                  }));
                }
              }}
            >
              ＋ 添加排序
            </button>
          </section>

          <section>
            <h4>隐藏列</h4>
            <div className="hidden-cols">
              {columns.map((c) => (
                <label className="hidden-col" key={c.id}>
                  <input
                    type="checkbox"
                    checked={draft.hidden_columns.includes(c.id)}
                    onChange={(e) => {
                      const hidden = e.target.checked
                        ? [...draft.hidden_columns, c.id]
                        : draft.hidden_columns.filter((id) => id !== c.id);
                      setDraft((d) => ({ ...d, hidden_columns: hidden }));
                    }}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </section>
        </div>
        <div className="panel-foot">
          <button
            className="btn"
            onClick={() =>
              setDraft({ filters: null, sorts: [], hidden_columns: [] })
            }
          >
            重置
          </button>
          <div className="toolbar-spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void save()}>
            保存并应用
          </button>
        </div>
      </div>
    </div>
  );
}
