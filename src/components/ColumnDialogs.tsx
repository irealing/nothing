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
  ColumnAlign,
  ColumnColor,
  ColumnMeta,
  ColumnOpts,
  ColumnType,
  FormulaResultType,
  Json,
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

/** The dynamic date default (`{"kind":"now"}`), resolved on insert. */
function isNowToken(v: Json | null | undefined): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && (v as { kind?: unknown }).kind === "now";
}

/** Type-appropriate starting point when a default is first enabled. */
function emptyDefaultFor(type: ColumnType, opts: ColumnOpts): Json {
  switch (type) {
    case "number":
      return 0;
    case "checkbox":
      return false;
    case "date":
      return todayIso();
    case "select":
      return opts.kind === "select" ? (opts.choices[0]?.name ?? "") : "";
    case "multi_select":
      return [];
    default:
      return "";
  }
}

/** Local (not UTC) calendar date, `yyyy-mm-dd`. */
function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
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
  const [align, setAlign] = useState<ColumnAlign | null>(existing?.align ?? null);
  const initialDefault = existing?.default_value ?? null;
  const [defaultEnabled, setDefaultEnabled] = useState(
    initialDefault !== null && initialDefault !== undefined,
  );
  const [defaultValue, setDefaultValue] = useState<Json | null>(initialDefault);
  const [error, setError] = useState<string | null>(null);

  const isTitle = !!existing && existing.id === activeTable?.title_col_id;
  const typeLocked = !!existing && (existing.type === "relation" || existing.is_reverse || isTitle);
  const defaultUnsupported =
    type === "formula" || type === "relation" || !!existing?.is_reverse;
  const selectChoices =
    opts.kind === "select" || opts.kind === "multi_select" ? opts.choices : [];
  const defaultBlocked =
    (type === "select" || type === "multi_select") && selectChoices.length === 0;

  // Columns a formula may reference: physical, non-generated, non-reverse.
  const referenceable = useMemo(
    () => columns.filter((c) => c.type !== "formula" && c.type !== "relation" && !c.is_reverse),
    [columns],
  );

  const changeType = (next: ColumnType) => {
    setType(next);
    setOpts((prev) => optsForType(next, prev));
    // A default is type-specific: start clean instead of sending a value the
    // new type would reject.
    setDefaultEnabled(false);
    setDefaultValue(null);
  };

  const toggleDefault = (on: boolean) => {
    setDefaultEnabled(on);
    if (!on) {
      setDefaultValue(null);
    } else if (defaultValue === null) {
      setDefaultValue(emptyDefaultFor(type, opts));
    }
  };

  const setChoices = (fn: (choices: Choice[]) => Choice[]) => {
    if (opts.kind !== "select" && opts.kind !== "multi_select") return;
    const choices = fn(opts.choices);
    setOpts({ ...opts, choices });
    if (!defaultEnabled) return;
    if (choices.length === 0) {
      setDefaultEnabled(false);
      setDefaultValue(null);
      return;
    }
    // Keep the default valid when choices are renamed or removed.
    const names = new Set(choices.map((c) => c.name));
    if (opts.kind === "select") {
      setDefaultValue((cur) =>
        typeof cur === "string" && names.has(cur) ? cur : (choices[0]?.name ?? null),
      );
    } else {
      setDefaultValue((cur) =>
        Array.isArray(cur) ? cur.map(String).filter((n) => names.has(n)) : [],
      );
    }
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
    // A blank text default would store '' instead of NULL, which is not a
    // meaningful default; treat it as "none".
    const defaultActive =
      defaultEnabled && !defaultBlocked && !(type === "text" && defaultValue === "");
    const defaultPayload: Json = defaultActive ? defaultValue : null;
    // Reverse columns may only change presentation, and the backend rejects any
    // `opts` patch on them. Omitting unchanged options also avoids an
    // unnecessary table rebuild.
    const optsChanged = !existing || JSON.stringify(opts) !== JSON.stringify(existing.opts);
    if (existing) {
      await updateColumn(existing.id, {
        name: name.trim(),
        ...(type !== existing.type ? { type } : {}),
        ...(optsChanged ? { opts } : {}),
        icon: icon ?? "",
        color: color ?? "",
        align: align ?? "",
        ...(defaultActive && defaultPayload !== null
          ? { default_value: defaultPayload }
          : { clear_default: true }),
      });
    } else {
      const col: NewColumn = {
        name: name.trim(),
        type,
        opts,
        icon,
        color,
        align,
        default_value: defaultPayload,
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

  const defaultEditor = (() => {
    switch (type) {
      case "number":
        return (
          <Input
            type="number"
            value={defaultValue === null || defaultValue === undefined ? "" : String(defaultValue)}
            onChange={(e) => setDefaultValue(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        );
      case "checkbox":
        return (
          <label className="checkline">
            <input
              type="checkbox"
              checked={defaultValue === true}
              onChange={(e) => setDefaultValue(e.target.checked)}
            />
            {t("column.defaultCheckbox")}
          </label>
        );
      case "date": {
        const nowMode = isNowToken(defaultValue);
        return (
          <div className="default-editor">
            <Select
              value={nowMode ? "now" : "fixed"}
              onChange={(v) =>
                setDefaultValue(v === "now" ? { kind: "now" } : todayIso())
              }
              options={[
                { value: "fixed", label: t("column.defaultDateFixed") },
                { value: "now", label: t("column.defaultDateNow") },
              ]}
            />
            {!nowMode && (
              <Input
                type="date"
                value={typeof defaultValue === "string" ? defaultValue.slice(0, 10) : ""}
                onChange={(e) => setDefaultValue(e.target.value)}
              />
            )}
            <p className="hint">{t("column.defaultDateHint")}</p>
          </div>
        );
      }
      case "select":
        return (
          <Select
            value={
              typeof defaultValue === "string" ? defaultValue : (selectChoices[0]?.name ?? "")
            }
            onChange={(v) => setDefaultValue(v)}
            options={selectChoices.map((c) => ({ value: c.name, label: c.name }))}
          />
        );
      case "multi_select": {
        const selected = Array.isArray(defaultValue) ? defaultValue.map(String) : [];
        return (
          <div className="ref-chips">
            {selectChoices.map((c) => {
              const on = selected.includes(c.name);
              return (
                <button
                  key={c.id}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  onClick={() =>
                    setDefaultValue(
                      on ? selected.filter((n) => n !== c.name) : [...selected, c.name],
                    )
                  }
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        );
      }
      default:
        return (
          <Input
            value={typeof defaultValue === "string" ? defaultValue : ""}
            placeholder={t("column.defaultValuePlaceholder")}
            onChange={(e) => setDefaultValue(e.target.value)}
          />
        );
    }
  })();

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
          {type !== "select" && type !== "multi_select" && type !== "relation" && (
            <div className="appearance-item">
              <span className="field-label">{t("column.align")}</span>
              <Select
                value={align ?? "auto"}
                onChange={(v) => setAlign(v === "auto" ? null : (v as ColumnAlign))}
                options={[
                  { value: "auto", label: t("column.alignAuto") },
                  { value: "left", label: t("column.alignLeft") },
                  { value: "center", label: t("column.alignCenter") },
                  { value: "right", label: t("column.alignRight") },
                ]}
              />
            </div>
          )}
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

        {defaultUnsupported ? (
          <p className="hint">{t("column.defaultUnsupported")}</p>
        ) : (
          <div className="form panel-box">
            <label className="checkline">
              <input
                type="checkbox"
                checked={defaultEnabled}
                disabled={defaultBlocked}
                onChange={(e) => toggleDefault(e.target.checked)}
              />
              {t("column.defaultEnable")}
            </label>
            {defaultBlocked ? (
              <p className="hint">{t("cell.noChoices")}</p>
            ) : (
              defaultEnabled && (
                <Field label={t("column.defaultValue")}>{defaultEditor}</Field>
              )
            )}
            <p className="hint">{t("column.defaultHint")}</p>
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