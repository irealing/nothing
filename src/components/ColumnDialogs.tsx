// Add/edit column dialog covering every column type, including the formula
// editor (whitelist syntax help + clickable column references) and select
// choices / relation options editors, plus presentation (emoji + color).

import { useMemo, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { t } from "../i18n";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { ColorSwatches, EmojiPicker } from "../ui/ColumnPickers";
import { ColumnTypeIcon, IconPlus, IconSigma, IconX } from "./icons";
import type {
  Choice,
  ColumnColor,
  ColumnMeta,
  ColumnOpts,
  ColumnType,
  FormulaResultType,
  NewColumn,
} from "../types";

const ALL_TYPES: ColumnType[] = [
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "multi_select",
  "relation",
  "formula",
];

function newChoice(name: string): Choice {
  return { id: crypto.randomUUID(), name };
}

function optsForType(type: ColumnType, prev?: ColumnOpts): ColumnOpts {
  switch (type) {
    case "select":
      return prev?.kind === "select" ? prev : { kind: "select", choices: [] };
    case "multi_select":
      return prev?.kind === "multi_select" ? prev : { kind: "multi_select", choices: [] };
    case "relation":
      return prev?.kind === "relation"
        ? prev
        : { kind: "relation", target_table_id: "", single: false, reverse_name: null };
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
  const activeTable = tables.find((x) => x.id === activeTableId) ?? null;

  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<ColumnType>(existing?.type ?? "text");
  const [opts, setOpts] = useState<ColumnOpts>(() => optsForType(existing?.type ?? "text", existing?.opts));
  const [icon, setIcon] = useState<string | null>(existing?.icon ?? null);
  const [color, setColor] = useState<ColumnColor | null>(existing?.color ?? null);
  const [error, setError] = useState<string | null>(null);

  const isTitle = !!existing && existing.id === activeTable?.title_col_id;
  const typeLocked = !!existing && (existing.type === "relation" || existing.is_reverse || isTitle);

  // Columns a formula may reference: physical, non-generated, non-reverse.
  const referenceable = useMemo(
    () => columns.filter((c) => c.type !== "formula" && c.type !== "relation" && !c.is_reverse),
    [columns],
  );

  const changeType = (next: ColumnType) => {
    setType(next);
    setOpts((prev) => optsForType(next, prev));
  };

  const setChoices = (fn: (choices: Choice[]) => Choice[]) => {
    setOpts((prev) => {
      if (prev.kind !== "select" && prev.kind !== "multi_select") return prev;
      return { ...prev, choices: fn(prev.choices) };
    });
  };

  const submit = async () => {
    if (!name.trim()) return setError(t("column.nameRequired"));
    if (type === "relation" && opts.kind === "relation" && !opts.target_table_id) {
      return setError(t("column.targetRequired"));
    }
    if (type === "formula" && opts.kind === "formula" && !opts.expr.trim()) {
      return setError(t("column.formulaRequired"));
    }
    setError(null);
    if (existing) {
      await updateColumn(existing.id, {
        name: name.trim(),
        ...(type !== existing.type ? { type } : {}),
        opts,
        icon: icon ?? "",
        color: color ?? "",
      });
    } else {
      const col: NewColumn = {
        name: name.trim(),
        type,
        opts,
        icon,
        color,
      };
      await addColumn(col);
    }
    onClose();
  };

  const choicesEditor = (
    <div className="choices-editor">
      <span className="field-label">{t("column.choices")}</span>
      {(opts.kind === "select" || opts.kind === "multi_select") &&
        opts.choices.map((c, i) => (
          <div className="extra-col-row" key={c.id}>
            <Input
              value={c.name}
              placeholder={t("column.choicePlaceholder", { n: i + 1 })}
              onChange={(e) =>
                setChoices((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
            <button
              type="button"
              className="btn-icon danger"
              title={t("column.deleteChoice")}
              onClick={() => setChoices((list) => list.filter((_, j) => j !== i))}
            >
              <IconX size={13} />
            </button>
          </div>
        ))}
      <button
        type="button"
        className="btn dashed"
        onClick={() => setChoices((list) => [...list, newChoice("")])}
      >
        <IconPlus size={14} /> {t("column.addChoice")}
      </button>
      <p className="hint">{t("column.choicesHint")}</p>
    </div>
  );

  return (
    <Dialog
      title={
        existing ? t("column.editTitle", { name: existing.name }) : t("column.addTitle")
      }
      subtitle={existing ? t("column.subtitleEdit") : t("column.subtitleAdd")}
      onClose={onClose}
      wide
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="form-grid">
          <Field label={t("column.name")}>
            <Input
              value={name}
              autoFocus
              placeholder={t("column.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={typeLocked ? `${t("column.type")}${t("column.typeLockedHint")}` : t("column.type")}>
            <Select
              value={type}
              onChange={(v) => changeType(v as ColumnType)}
              disabled={typeLocked}
              options={ALL_TYPES.map((value) => ({
                value,
                label: t(`types.${value}`),
                leading: <ColumnTypeIcon type={value} size={14} />,
              }))}
            />
          </Field>
        </div>

        <div className="appearance-row">
          <div className="appearance-item">
            <span className="field-label">{t("column.icon")}</span>
            <EmojiPicker value={icon} onChange={setIcon} />
          </div>
          <div className="appearance-item">
            <span className="field-label">{t("column.color")}</span>
            <ColorSwatches value={color} onChange={setColor} />
          </div>
        </div>

        {(type === "select" || type === "multi_select") && choicesEditor}

        {type === "relation" && opts.kind === "relation" && (
          <div className="form panel-box">
            <Field label={t("column.targetTable")}>
              <Select
                value={opts.target_table_id}
                disabled={!!existing}
                onChange={(v) => setOpts({ ...opts, target_table_id: v })}
                options={tables.map((table) => ({
                  value: table.id,
                  label:
                    table.id === activeTableId
                      ? `${table.name}${t("column.selfRelation")}`
                      : table.name,
                }))}
              />
            </Field>
            <label className="checkline">
              <input
                type="checkbox"
                checked={opts.single}
                onChange={(e) => setOpts({ ...opts, single: e.target.checked })}
              />
              {t("column.singleRelation")}
            </label>
            {!existing && (
              <Field label={t("column.reverseName")}>
                <Input
                  value={opts.reverse_name ?? ""}
                  placeholder={t("column.noReverse")}
                  onChange={(e) => setOpts({ ...opts, reverse_name: e.target.value || null })}
                />
              </Field>
            )}
            <p className="hint">{t("column.relationHint")}</p>
          </div>
        )}

        {type === "formula" && opts.kind === "formula" && (
          <div className="form panel-box">
            <Field label={t("column.formulaExpr")}>
              <Textarea
                rows={3}
                value={opts.expr}
                placeholder={t("column.formulaPlaceholder")}
                onChange={(e) => setOpts({ ...opts, expr: e.target.value })}
              />
            </Field>
            <div className="ref-chips">
              {referenceable.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="chip"
                  title={t("column.insertRef")}
                  onClick={() => setOpts({ ...opts, expr: opts.expr + `[${c.name}]` })}
                >
                  [{c.name}]
                </button>
              ))}
            </div>
            <Field label={t("column.resultType")}>
              <Select
                value={opts.result_type}
                onChange={(v) => setOpts({ ...opts, result_type: v as FormulaResultType })}
                options={[
                  { value: "number", label: t("types.number") },
                  { value: "text", label: t("types.text") },
                  { value: "date", label: t("types.date") },
                  { value: "checkbox", label: t("types.checkbox") },
                ]}
              />
            </Field>
            <p className="hint">
              <IconSigma size={12} /> {t("column.formulaHelp")}
            </p>
            <p className="hint">{t("column.formulaGenerated")}</p>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary">
            {existing ? t("column.save") : t("column.add")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}