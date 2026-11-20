// Add/edit column dialog covering every column type, including the formula
// editor (whitelist syntax help + clickable column references) and select
// choices / relation options editors, plus presentation (emoji + color).
//
// Layout mirrors a grid header — icon, name, type, color, preview — so the
// dialog is dense instead of stacking one labelled field per row. Enter only
// submits from the name field: in every other single-line input it would
// silently save a half-finished column.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { t } from "../i18n";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select, Textarea, handleFormEnter } from "../ui/Field";
import { ColorPicker, EmojiPicker } from "../ui/ColumnPickers";
import { tagCellStyle, tagChipStyle } from "../theme/grid";
import { ColumnTypeIcon, IconChevronDown, IconPlus, IconSigma, IconX } from "./icons";
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

/** Choices are stored trimmed; the dialog only trims on submit so typing keeps
 * the caret where the user put it. */
function trimChoices(opts: ColumnOpts): ColumnOpts {
  if (opts.kind !== "select" && opts.kind !== "multi_select") return opts;
  return { ...opts, choices: opts.choices.map((c) => ({ ...c, name: c.name.trim() })) };
}

function previewAlign(type: ColumnType, opts: ColumnOpts, align: ColumnAlign | null): ColumnAlign {
  if (align) return align;
  if (type === "number") return "right";
  if (type === "formula" && opts.kind === "formula" && opts.result_type === "number") return "right";
  return "left";
}

function previewValue(type: ColumnType, opts: ColumnOpts): string {
  switch (type) {
    case "number":
      return "123";
    case "date":
      return todayIso();
    case "checkbox":
      return "✓";
    case "select":
    case "multi_select":
      return opts.kind === "select" || opts.kind === "multi_select"
        ? (opts.choices[0]?.name ?? "—")
        : "—";
    case "formula":
      return t("column.previewSample");
    default:
      return t("column.previewSample");
  }
}

/** Live DOM mock of the grid header + one cell for the current presentation. */
function ColumnPreview({
  icon,
  name,
  type,
  opts,
  color,
  align,
}: {
  icon: string | null;
  name: string;
  type: ColumnType;
  opts: ColumnOpts;
  color: ColumnColor | null;
  align: ColumnAlign | null;
}) {
  const headerStyle = color ? tagChipStyle(color) : undefined;
  const cellStyle = color ? tagCellStyle(color) : undefined;
  const contentAlign = previewAlign(type, opts, align);
  return (
    <div className="column-preview" role="img" aria-label={t("column.preview")}>
      <div className="column-preview-head" style={headerStyle}>
        <span className="column-preview-icon">
          {icon ? <span className="column-preview-emoji">{icon}</span> : <ColumnTypeIcon type={type} size={13} />}
        </span>
        <span className="column-preview-name">{name.trim() || t("column.previewUntitled")}</span>
        <IconChevronDown size={10} className="column-preview-caret" />
      </div>
      <div className="column-preview-cell" style={cellStyle}>
        <span className="column-preview-value" style={{ textAlign: contentAlign }}>
          {previewValue(type, opts)}
        </span>
      </div>
    </div>
  );
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
  const [busy, setBusy] = useState(false);
  const [focusChoiceId, setFocusChoiceId] = useState<string | null>(null);
  const choiceRefs = useRef(new Map<string, HTMLInputElement>());

  // Focus the freshly added option after its input exists.
  useLayoutEffect(() => {
    if (!focusChoiceId) return;
    choiceRefs.current.get(focusChoiceId)?.focus();
    setFocusChoiceId(null);
  }, [focusChoiceId]);

  const isTitle = !!existing && existing.id === activeTable?.title_col_id;
  const typeLocked = !!existing && (existing.type === "relation" || existing.is_reverse || isTitle);
  const defaultUnsupported =
    type === "formula" || type === "relation" || !!existing?.is_reverse;
  const selectChoices =
    opts.kind === "select" || opts.kind === "multi_select" ? opts.choices : [];
  const defaultBlocked =
    (type === "select" || type === "multi_select") && selectChoices.length === 0;
  const showAlign = type !== "select" && type !== "multi_select" && type !== "relation";

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

  /** Append an empty option after `index` (defaults to the end) and focus it. */
  const addChoice = (index?: number) => {
    const choice = newChoice("");
    setChoices((list) => {
      const at = index === undefined ? list.length : Math.min(index + 1, list.length);
      return [...list.slice(0, at), choice, ...list.slice(at)];
    });
    setFocusChoiceId(choice.id);
  };

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) return setError(t("column.nameRequired"));
    const cleanedOpts = trimChoices(opts);
    if (cleanedOpts.kind === "select" || cleanedOpts.kind === "multi_select") {
      const names = cleanedOpts.choices.map((c) => c.name);
      if (names.some((n) => !n)) return setError(t("column.choiceRequired"));
      if (new Set(names).size !== names.length) return setError(t("column.choiceDuplicate"));
    }
    if (type === "relation" && cleanedOpts.kind === "relation" && !cleanedOpts.target_table_id) {
      return setError(t("column.targetRequired"));
    }
    if (type === "formula" && cleanedOpts.kind === "formula" && !cleanedOpts.expr.trim()) {
      return setError(t("column.formulaRequired"));
    }
    setError(null);

    // Normalize type-specific defaults against the (trimmed) choices so a
    // renamed option cannot leave a dangling default behind.
    const choiceNames =
      cleanedOpts.kind === "select" || cleanedOpts.kind === "multi_select"
        ? cleanedOpts.choices.map((c) => c.name)
        : [];
    let normalized: Json | null = defaultValue;
    if (type === "select" && typeof normalized === "string") {
      normalized = choiceNames.includes(normalized.trim()) ? normalized.trim() : null;
    } else if (type === "multi_select" && Array.isArray(normalized)) {
      normalized = normalized
        .map(String)
        .map((n) => n.trim())
        .filter((n) => choiceNames.includes(n));
    }
    // A blank text default would store '' instead of NULL, which is not a
    // meaningful default; treat it as "none".
    const defaultActive =
      defaultEnabled && !defaultBlocked && !(type === "text" && normalized === "");
    const defaultPayload: Json = defaultActive ? normalized : null;
    // Reverse columns may only change presentation, and the backend rejects any
    // `opts` patch on them. Omitting unchanged options also avoids an
    // unnecessary table rebuild.
    const optsChanged = !existing || JSON.stringify(cleanedOpts) !== JSON.stringify(existing.opts);
    setBusy(true);
    try {
      let ok: boolean;
      if (existing) {
        ok = await updateColumn(existing.id, {
          name: name.trim(),
          ...(type !== existing.type ? { type } : {}),
          ...(optsChanged ? { opts: cleanedOpts } : {}),
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
          opts: cleanedOpts,
          icon,
          color,
          align,
          default_value: defaultPayload,
        };
        ok = await addColumn(col);
      }
      // Keeping the dialog open on failure preserves everything the user typed.
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  const choicesEditor = (
    <div className="choices-editor">
      <span className="field-label">{t("column.choices")}</span>
      {selectChoices.map((c, i) => (
        <div className="extra-col-row" key={c.id}>
          <Input
            value={c.name}
            placeholder={t("column.choicePlaceholder", { n: i + 1 })}
            ref={(el) => {
              if (el) choiceRefs.current.set(c.id, el);
              else choiceRefs.current.delete(c.id);
            }}
            onChange={(e) =>
              setChoices((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
            }
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Let an IME confirm its candidate first.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              e.stopPropagation();
              if (!c.name.trim()) return;
              addChoice(i);
            }}
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
      <button type="button" className="btn dashed" onClick={() => addChoice()}>
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
            disabled={!defaultEnabled}
            value={defaultValue === null || defaultValue === undefined ? "" : String(defaultValue)}
            onChange={(e) => setDefaultValue(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        );
      case "checkbox":
        return (
          <label className="checkline">
            <input
              type="checkbox"
              disabled={!defaultEnabled}
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
            <div className="default-date-mode">
              <Select
                value={nowMode ? "now" : "fixed"}
                disabled={!defaultEnabled}
                onChange={(v) =>
                  setDefaultValue(v === "now" ? { kind: "now" } : todayIso())
                }
                options={[
                  { value: "fixed", label: t("column.defaultDateFixed") },
                  { value: "now", label: t("column.defaultDateNow") },
                ]}
              />
            </div>
            {!nowMode && (
              <Input
                type="date"
                disabled={!defaultEnabled}
                value={typeof defaultValue === "string" ? defaultValue.slice(0, 10) : ""}
                onChange={(e) => setDefaultValue(e.target.value)}
              />
            )}
          </div>
        );
      }
      case "select":
        return (
          <Select
            value={
              typeof defaultValue === "string" ? defaultValue : (selectChoices[0]?.name ?? "")
            }
            disabled={!defaultEnabled}
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
                  disabled={!defaultEnabled}
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
            disabled={!defaultEnabled}
            value={typeof defaultValue === "string" ? defaultValue : ""}
            placeholder={t("column.defaultValuePlaceholder")}
            onChange={(e) => setDefaultValue(e.target.value)}
          />
        );
    }
  })();

  const dateNowDefault = type === "date" && isNowToken(defaultValue);

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
        onKeyDown={(e) => handleFormEnter(e, () => void submit())}
      >
        <div className="column-identity">
          <EmojiPicker value={icon} onChange={setIcon} />
          <Input
            className="ui-input column-name-input"
            value={name}
            autoFocus
            data-enter-submit="true"
            aria-label={t("column.name")}
            placeholder={t("column.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="column-type">
            <Select
              value={type}
              onChange={(v) => changeType(v as ColumnType)}
              disabled={typeLocked}
              ariaLabel={
                typeLocked ? `${t("column.type")}${t("column.typeLockedHint")}` : t("column.type")
              }
              options={ALL_TYPES.map((value) => ({
                value,
                label: t(`types.${value}`),
                leading: <ColumnTypeIcon type={value} size={14} />,
              }))}
            />
          </div>
          <ColorPicker value={color} onChange={setColor} />
          <ColumnPreview
            icon={icon}
            name={name}
            type={type}
            opts={opts}
            color={color}
            align={align}
          />
        </div>

        {showAlign && (
          <div className="column-align-row">
            <span className="field-label">{t("column.align")}</span>
            <div className="column-align">
              <Select
                value={align ?? "auto"}
                onChange={(v) => setAlign(v === "auto" ? null : (v as ColumnAlign))}
                ariaLabel={t("column.align")}
                options={[
                  { value: "auto", label: t("column.alignAuto") },
                  { value: "left", label: t("column.alignLeft") },
                  { value: "center", label: t("column.alignCenter") },
                  { value: "right", label: t("column.alignRight") },
                ]}
              />
            </div>
          </div>
        )}

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
          <>
            <div className="default-row" data-off={!defaultEnabled || defaultBlocked}>
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
                <span className="default-note">{t("cell.noChoices")}</span>
              ) : (
                <fieldset className="default-value" disabled={!defaultEnabled}>
                  {defaultEditor}
                </fieldset>
              )}
            </div>
            {!defaultBlocked && (
              <p className="hint">
                {dateNowDefault ? t("column.defaultDateHint") : t("column.defaultHint")}
              </p>
            )}
          </>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {existing ? t("column.save") : t("column.add")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}