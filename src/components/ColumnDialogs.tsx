// Add/edit column dialog covering every column type, including the formula
// editor (whitelist syntax help + clickable column references) and select
// choices / relation options editors.

import { useMemo, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { Modal } from "./dialogs";
import type { Choice, ColumnMeta, ColumnOpts, ColumnType, FormulaResultType, NewColumn } from "../types";

const TYPE_LABELS: Record<ColumnType, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  checkbox: "复选框",
  select: "单选",
  multi_select: "多选",
  relation: "关联",
  formula: "公式",
};

const ALL_TYPES = Object.keys(TYPE_LABELS) as ColumnType[];

const FORMULA_HELP =
  "语法：[列名] 引用、+ - * / %、比较（= <> < <= > >=）、AND / OR / NOT、括号；" +
  "函数：abs round lower upper length trim ltrim rtrim substr coalesce ifnull min max date datetime。" +
  "不能引用公式列与关联列。";

function newChoice(name: string): Choice {
  return { id: crypto.randomUUID(), name };
}

function optsForType(t: ColumnType, prev?: ColumnOpts): ColumnOpts {
  switch (t) {
    case "select":
      return prev?.kind === "select" ? prev : { kind: "select", choices: [] };
    case "multi_select":
      return prev?.kind === "multi_select" ? prev : { kind: "multi_select", choices: [] };
    case "relation":
      return prev?.kind === "relation" ? prev : { kind: "relation", target_table_id: "", single: false, reverse_name: null };
    case "formula":
      return prev?.kind === "formula" ? prev : { kind: "formula", expr: "", result_type: "number" };
    default:
      return { kind: "plain" };
  }
}

export default function ColumnDialog({
  existing,
  onClose,
}: {
  existing?: ColumnMeta | null;
  onClose: () => void;
}) {
  const addColumn = useWorkspace((s) => s.addColumn);
  const updateColumn = useWorkspace((s) => s.updateColumn);
  const columns = useWorkspace((s) => s.columns);
  const tables = useWorkspace((s) => s.tables);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const activeTable = tables.find((t) => t.id === activeTableId) ?? null;

  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<ColumnType>(existing?.type ?? "text");
  const [opts, setOpts] = useState<ColumnOpts>(() => optsForType(existing?.type ?? "text", existing?.opts));

  const isTitle = !!existing && existing.id === activeTable?.title_col_id;
  const typeLocked = !!existing && (existing.type === "relation" || existing.is_reverse || isTitle);

  // Columns a formula may reference: physical, non-generated, non-reverse.
  const referenceable = useMemo(
    () => columns.filter((c) => c.type !== "formula" && c.type !== "relation" && !c.is_reverse),
    [columns],
  );

  const changeType = (t: ColumnType) => {
    setType(t);
    setOpts((prev) => optsForType(t, prev));
  };

  const setChoices = (fn: (choices: Choice[]) => Choice[]) => {
    setOpts((prev) => {
      if (prev.kind !== "select" && prev.kind !== "multi_select") return prev;
      return { ...prev, choices: fn(prev.choices) };
    });
  };

  const submit = async () => {
    if (!name.trim()) return;
    if (type === "relation" && opts.kind === "relation" && !opts.target_table_id) return;
    if (type === "formula" && opts.kind === "formula" && !opts.expr.trim()) return;
    if (existing) {
      await updateColumn(existing.id, {
        name: name.trim(),
        ...(type !== existing.type ? { type } : {}),
        opts,
      });
    } else {
      const col: NewColumn = { name: name.trim(), type, opts };
      await addColumn(col);
    }
    onClose();
  };

  const choicesEditor = (
    <div className="choices-editor">
      {(opts.kind === "select" || opts.kind === "multi_select") &&
        opts.choices.map((c, i) => (
          <div className="extra-col-row" key={c.id}>
            <input
              value={c.name}
              placeholder={`选项 ${i + 1}`}
              onChange={(e) =>
                setChoices((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
            <button
              type="button"
              className="btn-icon danger"
              onClick={() => setChoices((list) => list.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      <button type="button" className="btn" onClick={() => setChoices((list) => [...list, newChoice("")])}>
        ＋ 添加选项
      </button>
      <p className="hint">收窄选项列表时，已有的非法值会被置空（数据库事务保证）。</p>
    </div>
  );

  return (
    <Modal title={existing ? `编辑列「${existing.name}」` : "添加列"} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          列名
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          类型{isTitle && "（标题列必须是文本）"}
          <select
            value={type}
            disabled={typeLocked}
            onChange={(e) => changeType(e.target.value as ColumnType)}
          >
            {ALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {(type === "select" || type === "multi_select") && choicesEditor}

        {type === "relation" && opts.kind === "relation" && (
          <div className="form">
            <label>
              目标表
              <select
                value={opts.target_table_id}
                disabled={!!existing}
                onChange={(e) => setOpts({ ...opts, target_table_id: e.target.value })}
              >
                <option value="" disabled>
                  选择…
                </option>
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.id === activeTableId ? "（本表，自关联）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkline">
              <input
                type="checkbox"
                checked={opts.single}
                onChange={(e) => setOpts({ ...opts, single: e.target.checked })}
              />
              只允许关联一行（单选）
            </label>
            {!existing && (
              <label>
                反向列名（可选，在目标表显示）
                <input
                  value={opts.reverse_name ?? ""}
                  placeholder={opts.reverse_name === null ? "不创建" : ""}
                  onChange={(e) =>
                    setOpts({ ...opts, reverse_name: e.target.value || null })
                  }
                />
              </label>
            )}
            <p className="hint">
              关联数据存放在独立的关联表中，外键级联保证删除行时链接自动清理。
            </p>
          </div>
        )}

        {type === "formula" && opts.kind === "formula" && (
          <div className="form">
            <label>
              公式表达式
              <textarea
                rows={3}
                value={opts.expr}
                placeholder="例如：[单价] * [数量]"
                onChange={(e) => setOpts({ ...opts, expr: e.target.value })}
              />
            </label>
            <div className="ref-chips">
              {referenceable.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="chip"
                  title="点击插入引用"
                  onClick={() => setOpts({ ...opts, expr: opts.expr + `[${c.name}]` })}
                >
                  [{c.name}]
                </button>
              ))}
            </div>
            <label>
              结果类型
              <select
                value={opts.result_type}
                onChange={(e) =>
                  setOpts({ ...opts, result_type: e.target.value as FormulaResultType })
                }
              >
                <option value="number">数字</option>
                <option value="text">文本</option>
                <option value="date">日期</option>
                <option value="checkbox">复选框</option>
              </select>
            </label>
            <p className="hint">{FORMULA_HELP}</p>
            <p className="hint">
              公式编译为 SQLite Generated Column，由数据库在读写时自动维护。
            </p>
          </div>
        )}

        <button type="submit" className="btn primary">
          {existing ? "保存" : "添加"}
        </button>
      </form>
    </Modal>
  );
}
