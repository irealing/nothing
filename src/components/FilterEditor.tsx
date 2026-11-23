// Shared filter/sort editor for a grid view. It is deliberately controlled:
// the modal panel and the inline summary bar each own a draft and persist with
// their own footer, so both surfaces edit exactly the same rules.

import { useState, type ReactNode } from "react";
import type {
  Choice,
  ColumnMeta,
  FilterNode,
  FilterOp,
  FilterRule,
  GridConfig,
  Json,
} from "../types";
import { choicesOf, colType, isFilterGroup } from "../types";
import { IconChevronDown, IconPlus, IconSortAsc, IconSortDesc, IconX } from "./icons";
import { Checkbox, Select } from "../ui/Field";
import { Popover } from "../ui/Popover";
import { chipStyle, swatchStyle } from "../theme/grid";
import { t } from "../i18n";
import {
  NO_VALUE_OPS,
  OPS_BY_KIND,
  OP_LABELS,
  effectiveKind,
  initialFilterValue,
  isListOp,
  normalizeFilterValue,
  type FilterKind,
} from "./filterModel";

/** Column label with its optional emoji icon. */
export function colLabel(c: { icon: string | null; name: string }): string {
  return c.icon ? `${c.icon} ${c.name}` : c.name;
}

// ---- draft helpers -----------------------------------------------------------

/** Wrap a bare legacy rule in a top-level group (the editor edits a tree). */
export function normalizeFilters(filters: FilterNode | null): FilterNode | null {
  if (filters && !isFilterGroup(filters)) {
    return { op: "and", children: [filters] };
  }
  return filters;
}

/** Editable deep copy; also normalizes legacy single-rule configs. */
export function editableConfig(cfg: GridConfig): GridConfig {
  return {
    filters: normalizeFilters(cfg.filters),
    sorts: cfg.sorts.map((sort) => ({ ...sort })),
  };
}

/** Drop empty groups. */
export function pruneFilters(node: FilterNode | null): FilterNode | null {
  if (!node) return null;
  if (!isFilterGroup(node)) return node;
  const children = node.children
    .map(pruneFilters)
    .filter((child): child is FilterNode => child !== null);
  if (children.length === 0) return null;
  return { ...node, children };
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

// ---- value editors -----------------------------------------------------------

function ChoiceChip({ choice }: { choice: Pick<Choice, "icon" | "name" | "color"> }) {
  return (
    <span
      className="filter-choice-chip"
      style={choice.color ? chipStyle(choice.color) : undefined}
    >
      {choice.icon ? `${choice.icon} ` : ""}
      {choice.name}
    </span>
  );
}

function SingleChoicePicker({
  choices,
  value,
  onChange,
}: {
  choices: Choice[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="filter-value">
      <Select
        value={value}
        onChange={onChange}
        ariaLabel={t("filter.valuePlaceholder")}
        placeholder={t("common.choose")}
        options={choices.map((c) => ({
          value: c.name,
          label: `${c.icon ? `${c.icon} ` : ""}${c.name}`,
          leading: c.color ? (
            <span
              className="filter-choice-dot"
              style={{ background: swatchStyle(c.color).background }}
            />
          ) : undefined,
        }))}
      />
    </div>
  );
}

function MultiChoicePicker({
  choices,
  value,
  onChange,
}: {
  choices: Choice[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(value);
  const known = new Map(choices.map((c) => [c.name, c]));
  const labels = value.map((name) => known.get(name) ?? { name, icon: null, color: null });

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="filter-choice-popover"
      trigger={
        <button
          type="button"
          className="filter-value ui-input filter-choice-trigger"
          aria-expanded={open}
          aria-label={t("filter.valuePlaceholder")}
        >
          <span className="filter-choice-trigger-text">
            {labels.length === 0 ? (
              <span className="filter-choice-placeholder">{t("common.choose")}</span>
            ) : (
              labels
                .map((label) => `${label.icon ? `${label.icon} ` : ""}${label.name}`)
                .join(t("viewConfig.valueSeparator"))
            )}
          </span>
          <IconChevronDown size={12} />
        </button>
      }
    >
      <div className="filter-choice-list">
        {choices.map((c) => (
          <Checkbox
            key={c.id}
            className="filter-choice-item"
            checked={selected.has(c.name)}
            onChange={(on) =>
              onChange(
                on
                  ? [...value.filter((name) => name !== c.name), c.name]
                  : value.filter((name) => name !== c.name),
              )
            }
          >
            <ChoiceChip choice={c} />
          </Checkbox>
        ))}
      </div>
    </Popover>
  );
}

function ValueInput({
  kind,
  col,
  op,
  value,
  onChange,
}: {
  kind: FilterKind;
  col: ColumnMeta | undefined;
  op: FilterOp;
  value: Json;
  onChange: (v: Json) => void;
}) {
  if (!col) {
    return (
      <span className="filter-value filter-value-note">{t("viewConfig.unknownColumn")}</span>
    );
  }
  if (NO_VALUE_OPS.includes(op)) return null;

  const choices = choicesOf(col);
  if (kind === "select" || kind === "multi_select") {
    // A select column without choices has nothing meaningful to filter by;
    // never hide that behind a free-text box that the backend would reject.
    if (choices.length === 0) {
      return (
        <span className="filter-value filter-value-note">{t("filter.noChoicesHint")}</span>
      );
    }
    return isListOp(op) ? (
      <MultiChoicePicker
        choices={choices}
        value={Array.isArray(value) ? value.map(String) : []}
        onChange={onChange}
      />
    ) : (
      <SingleChoicePicker
        choices={choices}
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
      />
    );
  }

  if (isListOp(op)) {
    const text = Array.isArray(value) ? (value as Json[]).join(",") : String(value ?? "");
    return (
      <input
        className="filter-value"
        type="text"
        placeholder={t("filter.multiValuePlaceholder")}
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
          <option value="true">{t("filter.checked")}</option>
          <option value="false">{t("filter.unchecked")}</option>
        </select>
      );
    default:
      return (
        <input
          className="filter-value"
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={t("filter.valuePlaceholder")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

// ---- editor ------------------------------------------------------------------

export default function FilterEditor({
  filters,
  sorts,
  columns,
  onFiltersChange,
  onSortsChange,
}: {
  filters: FilterNode | null;
  sorts: GridConfig["sorts"];
  columns: ColumnMeta[];
  onFiltersChange: (filters: FilterNode | null) => void;
  onSortsChange: (sorts: GridConfig["sorts"]) => void;
}) {
  const addRule = (path: number[]) => {
    const col = columns[0];
    if (!col) return;
    const kind = effectiveKind(col);
    const op = OPS_BY_KIND[kind][0];
    const rule: FilterRule = {
      column_id: col.id,
      op,
      value: normalizeFilterValue(kind, op, initialFilterValue(kind)),
    };
    let root = filters;
    if (!root) root = { op: "and", children: [] };
    root = clone(root);
    const target = childAtPath(root, path);
    if (isFilterGroup(target)) target.children.push(rule);
    onFiltersChange(root);
  };

  const addGroup = (path: number[]) => {
    let root = filters;
    if (!root) root = { op: "and", children: [] };
    root = clone(root);
    const target = childAtPath(root, path);
    if (isFilterGroup(target)) target.children.push({ op: "or", children: [] });
    onFiltersChange(root);
  };

  const renderNode = (node: FilterNode, path: number[]): ReactNode => {
    if (isFilterGroup(node)) {
      return (
        <div className="filter-group" key={path.join(".")}>
          <div className="filter-group-head">
            <select
              value={node.op}
              onChange={(e) => {
                if (!filters) return;
                const next = clone(filters);
                const group = childAtPath(next, path);
                if (isFilterGroup(group)) group.op = e.target.value as "and" | "or";
                onFiltersChange(next);
              }}
            >
              <option value="and">{t("filter.and")}</option>
              <option value="or">{t("filter.or")}</option>
            </select>
            <div className="toolbar-spacer" />
            <button className="btn-icon text" title={t("filter.addRule")} onClick={() => addRule(path)}>
              <IconPlus size={13} /> {t("filter.addRule")}
            </button>
            {path.length > 0 && (
              <button className="btn-icon text" title={t("filter.addGroup")} onClick={() => addGroup(path)}>
                <IconPlus size={13} /> {t("filter.addGroup")}
              </button>
            )}
            {path.length > 0 && (
              <button
                className="btn-icon danger"
                title={t("filter.deleteGroup")}
                onClick={() => {
                  if (!filters) return;
                  const next = clone(filters);
                  const parentPath = path.slice(0, -1);
                  const parent = childAtPath(next, parentPath);
                  if (isFilterGroup(parent)) {
                    parent.children.splice(path[path.length - 1], 1);
                  }
                  onFiltersChange(next);
                }}
              >
                <IconX size={13} />
              </button>
            )}
          </div>
          <div className="filter-children">
            {node.children.length === 0 && path.length === 0 && (
              <div className="filter-empty">{t("filter.noFiltersHint")}</div>
            )}
            {node.children.map((child, i) => renderNode(child, [...path, i]))}
            {path.length === 0 && (
              <div className="filter-root-adds">
                <button className="btn" onClick={() => addRule([])}>
                  <IconPlus size={14} /> {t("filter.addRule")}
                </button>
                <button className="btn" onClick={() => addGroup([])}>
                  <IconPlus size={14} /> {t("filter.addGroup")}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    const rule = node;
    const col = columns.find((c) => c.id === rule.column_id);
    const kind = effectiveKind(col);
    const ops = OPS_BY_KIND[kind];
    return (
      <div className="filter-rule" key={path.join(".")}>
        <select
          className="filter-col"
          value={rule.column_id}
          onChange={(e) => {
            if (!filters) return;
            const nextCol = columns.find((c) => c.id === e.target.value);
            const nextKind = effectiveKind(nextCol);
            const nextOp = OPS_BY_KIND[nextKind].includes(rule.op)
              ? rule.op
              : OPS_BY_KIND[nextKind][0];
            const next = clone(filters);
            const r = childAtPath(next, path);
            if (!isFilterGroup(r)) {
              Object.assign(r, {
                column_id: e.target.value,
                op: nextOp,
                value: normalizeFilterValue(nextKind, nextOp, rule.value),
              });
            }
            onFiltersChange(next);
          }}
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {colLabel(c)}
            </option>
          ))}
          {!col && (
            <option value={rule.column_id} disabled>
              {t("viewConfig.unknownColumn")}
            </option>
          )}
        </select>
        <select
          className="filter-op"
          value={rule.op}
          onChange={(e) => {
            if (!filters) return;
            const nextOp = e.target.value as FilterOp;
            const next = clone(filters);
            const r = childAtPath(next, path);
            if (!isFilterGroup(r)) {
              r.op = nextOp;
              r.value = normalizeFilterValue(kind, nextOp, r.value);
            }
            onFiltersChange(next);
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
            if (!filters) return;
            const next = clone(filters);
            const r = childAtPath(next, path);
            if (!isFilterGroup(r)) r.value = v;
            onFiltersChange(next);
          }}
        />
        <button
          className="btn-icon danger"
          title={t("filter.deleteRule")}
          onClick={() => {
            if (!filters) return;
            const next = clone(filters);
            const parentPath = path.slice(0, -1);
            const parent = childAtPath(next, parentPath);
            if (isFilterGroup(parent)) parent.children.splice(path[path.length - 1], 1);
            onFiltersChange(next);
          }}
        >
          <IconX size={13} />
        </button>
      </div>
    );
  };

  return (
    <div className="filter-editor">
      <section>
        <h4>{t("filter.filters")}</h4>
        {filters ? (
          renderNode(filters, [])
        ) : (
          <div className="filter-empty">
            {t("filter.noFilters")}
            <div className="filter-root-adds">
              <button className="btn" onClick={() => addRule([])}>
                <IconPlus size={14} /> {t("filter.addRule")}
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h4>{t("filter.sorts")}</h4>
        {sorts.map((s, i) => (
          <div className="filter-rule" key={i}>
            <select
              className="filter-col"
              value={s.column_id}
              onChange={(e) => {
                const next = [...sorts];
                next[i] = { ...s, column_id: e.target.value };
                onSortsChange(next);
              }}
            >
              {columns
                .filter((c) => colType(c) !== "relation")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {colLabel(c)}
                  </option>
                ))}
            </select>
            <button
              className="btn sort-dir"
              title={s.desc ? t("filter.toggleDesc") : t("filter.toggleAsc")}
              onClick={() => {
                const next = [...sorts];
                next[i] = { ...s, desc: !s.desc };
                onSortsChange(next);
              }}
            >
              {s.desc ? <IconSortDesc size={14} /> : <IconSortAsc size={14} />}
              {s.desc ? t("filter.desc") : t("filter.asc")}
            </button>
            <button
              className="btn-icon danger"
              title={t("filter.deleteSort")}
              onClick={() => onSortsChange(sorts.filter((_, j) => j !== i))}
            >
              <IconX size={13} />
            </button>
          </div>
        ))}
        <button
          className="btn dashed"
          onClick={() => {
            const first = columns.find((c) => colType(c) !== "relation");
            if (first) {
              onSortsChange([...sorts, { column_id: first.id, desc: false }]);
            }
          }}
        >
          <IconPlus size={14} /> {t("filter.addSort")}
        </button>
      </section>
    </div>
  );
}