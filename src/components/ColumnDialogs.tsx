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
import { Field, Input, Select, Textarea, Checkbox, handleFormEnter } from "../ui/Field";
import { ColorPicker, EmojiMenu, EmojiPicker } from "../ui/ColumnPickers";
import { tagCellStyle, tagChipStyle } from "../theme/grid";
import { ColumnTypeIcon, IconChevronDown, IconPlus, IconSigma, IconX } from "./icons";
import type {
  ColumnAlign,
  ColumnColor,
  ColumnMeta,
  ColumnPatch,
  ColumnType,
  FormulaResultType,
  Json,
  NewChoice,
  NewColumn,
} from "../types";
import { choicesOf, colType, formulaResultType, isReverse } from "../types";

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

/** The dynamic date default (`{"kind":"now"}`), resolved on insert. */
function isNowToken(v: Json | null | undefined): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && (v as { kind?: unknown }).kind === "now";
}

/** Type-appropriate starting point when a default is first enabled. */
function emptyDefaultFor(type: ColumnType, choices: NewChoice[]): Json {
  switch (type) {
    case "number":
      return 0;
    case "checkbox":
      return false;
    case "date":
      return todayIso();
    case "select":
      return choices[0]?.name ?? "";
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

function previewAlign(
  type: ColumnType,
  resultType: FormulaResultType,
  align: ColumnAlign | null,
): ColumnAlign {
  if (align) return align;
  if (type === "number") return "right";
  if (type === "formula" && resultType === "number") return "right";
  return "left";
}

function previewValue(type: ColumnType, choices: NewChoice[]): string {
  switch (type) {
    case "number":
      return "123";
    case "date":
      return todayIso();
    case "checkbox":
      return "✓";
    case "select":
    case "multi_select":
      return choices[0]?.name ?? "—";
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
  resultType,
  choices,
  color,
  align,
}: {
  icon: string | null;
  name: string;
  type: ColumnType;
  resultType: FormulaResultType;
  choices: NewChoice[];
  color: ColumnColor | null;
  align: ColumnAlign | null;
}) {
  const headerStyle = color ? tagChipStyle(color) : undefined;
  const cellStyle = color ? tagCellStyle(color) : undefined;
  const contentAlign = previewAlign(type, resultType, align);
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
          {type === "select" || type === "multi_select" ? (
            <span
              className="column-preview-tag"
              style={
                choices[0]?.color
                  ? tagChipStyle(choices[0].color as ColumnColor)
                  : undefined
              }
            >
              {choices[0]?.icon ? `${choices[0].icon} ` : ""}
              {choices[0]?.name.trim() || t("column.previewUntitled")}
            </span>
          ) : (
            previewValue(type, choices)
          )}
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

  const initialType = existing ? colType(existing) : "text";
  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<ColumnType>(initialType);
  const [choices, setChoices] = useState<NewChoice[]>(() =>
    existing
      ? choicesOf(existing).map((c) => ({
          id: c.id,
          name: c.name,
          icon: c.icon,
          color: c.color,
        }))
      : [],
  );
  const [targetTableId, setTargetTableId] = useState(
    existing?.data.kind === "relation" ? existing.data.target_table_id : "",
  );
  const [single, setSingle] = useState(
    existing?.data.kind === "relation" ? existing.data.single : false,
  );
  const [reverseName, setReverseName] = useState("");
  const [formulaExpr, setFormulaExpr] = useState(
    existing?.data.kind === "formula" ? existing.data.expr : "",
  );
  const [resultType, setResultType] = useState<FormulaResultType>(
    existing ? (formulaResultType(existing) ?? "number") : "number",
  );
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

  const existingReverse = existing ? isReverse(existing) : false;
  const isTitle = !!existing && existing.id === activeTable?.title_col_id;
  const typeLocked = !!existing && (initialType === "relation" || existingReverse || isTitle);
  const defaultUnsupported = type === "formula" || type === "relation" || existingReverse;
  const defaultBlocked =
    (type === "select" || type === "multi_select") && choices.length === 0;
  const showAlign = type !== "select" && type !== "multi_select" && type !== "relation";

  // Columns a formula may reference: physical, non-generated, non-reverse.
  const referenceable = useMemo(
    () => columns.filter((c) => colType(c) !== "formula" && colType(c) !== "relation" && !isReverse(c)),
    [columns],
  );

  const changeType = (next: ColumnType) => {
    setType(next);
    if (next !== "select" && next !== "multi_select") setChoices([]);
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
      setDefaultValue(emptyDefaultFor(type, choices));
    }
  };

  const setChoiceList = (fn: (choices: NewChoice[]) => NewChoice[]) => {
    const next = fn(choices);
    setChoices(next);
    if (!defaultEnabled) return;
    if (next.length === 0) {
      setDefaultEnabled(false);
      setDefaultValue(null);
      return;
    }
    // Keep the default valid when choices are renamed or removed.
    const names = new Set(next.map((c) => c.name));
    if (type === "select") {
      setDefaultValue((cur) =>
        typeof cur === "string" && names.has(cur) ? cur : (next[0]?.name ?? null),
      );
    } else if (type === "multi_select") {
      setDefaultValue((cur) =>
        Array.isArray(cur) ? cur.map(String).filter((n) => names.has(n)) : [],
      );
    }
  };

  /** Append an empty option after `index` (defaults to the end) and focus it. */
  const addChoice = (index?: number) => {
    const choice: NewChoice = { id: crypto.randomUUID(), name: "", icon: null, color: null };
    setChoiceList((list) => {
      const at = index === undefined ? list.length : Math.min(index + 1, list.length);
      return [...list.slice(0, at), choice, ...list.slice(at)];
    });
    setFocusChoiceId(choice.id ?? null);
  };

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) return setError(t("column.nameRequired"));
    const cleanedChoices = choices.map((c) => ({ ...c, name: c.name.trim() }));
    if (type === "select" || type === "multi_select") {
      const names = cleanedChoices.map((c) => c.name);
      if (names.some((n) => !n)) return setError(t("column.choiceRequired"));
      if (new Set(names).size !== names.length) return setError(t("column.choiceDuplicate"));
    }
    if (type === "relation" && !targetTableId) return setError(t("column.targetRequired"));
    if (type === "formula" && !formulaExpr.trim()) return setError(t("column.formulaRequired"));
    setError(null);

    // Normalize type-specific defaults against the (trimmed) choices so a
    // renamed option cannot leave a dangling default behind.
    const choiceNames = cleanedChoices.map((c) => c.name);
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
    setBusy(true);
    try {
      let ok: boolean;
      if (existing) {
        const patch: ColumnPatch = {
          name: name.trim(),
          icon: icon ?? "",
          color: color ?? "",
          align: align ?? "",
        };
        if (type !== initialType) patch.type = type;
        if (!existingReverse) {
          if (type === "select" || type === "multi_select") {
            const before = choicesOf(existing).map((c) => [c.id, c.name, c.icon, c.color]);
            const after = cleanedChoices.map((c) => [c.id ?? null, c.name, c.icon ?? null, c.color ?? null]);
            if (JSON.stringify(before) !== JSON.stringify(after)) patch.choices = cleanedChoices;
          }
          if (type === "relation") {
            const rel = existing.data.kind === "relation" ? existing.data : null;
            if (rel?.target_table_id !== targetTableId) patch.target_table_id = targetTableId;
            if (rel?.single !== single) patch.single = single;
          }
          if (type === "formula") {
            const f = existing.data.kind === "formula" ? existing.data : null;
            if (f?.expr !== formulaExpr) patch.formula_expr = formulaExpr;
            if (f?.result_type !== resultType) patch.formula_result_type = resultType;
          }
          if (defaultUnsupported) {
            // no default payload
          } else if (defaultActive && defaultPayload !== null) {
            patch.default_value = defaultPayload;
          } else {
            patch.clear_default = true;
          }
        }
        ok = await updateColumn(existing.id, patch);
      } else {
        const col: NewColumn = {
          name: name.trim(),
          type,
          icon,
          color,
          align,
          default_value: defaultPayload,
        };
        if (type === "select" || type === "multi_select") col.choices = cleanedChoices;
        if (type === "relation") {
          col.target_table_id = targetTableId;
          col.single = single;
          col.reverse_name = reverseName || null;
        }
        if (type === "formula") {
          col.formula_expr = formulaExpr;
          col.formula_result_type = resultType;
        }
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
      <div className="choices-head">
        <span className="field-label">{t("column.choices")}</span>
        <span className="choices-count">{t("column.choiceCount", { count: choices.length })}</span>
        <div className="toolbar-spacer" />
        <button type="button" className="btn dashed small" onClick={() => addChoice()}>
          <IconPlus size={13} /> {t("column.addChoice")}
        </button>
      </div>
      <div className="choice-list">
        {choices.map((c, i) => (
          <div className="extra-col-row choice-row" key={c.id ?? i}>
            <EmojiMenu
              value={c.icon ?? null}
              onChange={(icon) =>
                setChoiceList((list) => list.map((x, j) => (j === i ? { ...x, icon } : x)))
              }
              trigger={
                <button
                  type="button"
                  className={c.icon ? "choice-icon-btn" : "choice-icon-btn empty"}
                  title={t("column.choiceIcon")}
                  aria-label={t("column.choiceIcon")}
                >
                  {c.icon ?? <IconPlus size={12} />}
                </button>
              }
            />
            <Input
              value={c.name}
              placeholder={t("column.choicePlaceholder", { n: i + 1 })}
              ref={(el) => {
                const key = c.id ?? String(i);
                if (el) choiceRefs.current.set(key, el);
                else choiceRefs.current.delete(key);
              }}
              onChange={(e) =>
                setChoiceList((list) =>
                  list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                )
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
            <ColorPicker
              value={(c.color as ColumnColor | null) ?? null}
              onChange={(color) =>
                setChoiceList((list) => list.map((x, j) => (j === i ? { ...x, color } : x)))
              }
            />
            <button
              type="button"
              className="btn-icon danger"
              title={t("column.deleteChoice")}
              onClick={() => setChoiceList((list) => list.filter((_, j) => j !== i))}
            >
              <IconX size={13} />
            </button>
          </div>
        ))}
      </div>
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
          <Checkbox
            disabled={!defaultEnabled}
            checked={defaultValue === true}
            onChange={setDefaultValue}
          >
            {t("column.defaultCheckbox")}
          </Checkbox>
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
              typeof defaultValue === "string" ? defaultValue : (choices[0]?.name ?? "")
            }
            disabled={!defaultEnabled}
            onChange={(v) => setDefaultValue(v)}
            options={choices.map((c) => ({
              value: c.name,
              label: `${c.icon ? `${c.icon} ` : ""}${c.name}`,
            }))}
          />
        );
      case "multi_select": {
        const selected = Array.isArray(defaultValue) ? defaultValue.map(String) : [];
        return (
          <div className="ref-chips">
            {choices.map((c) => {
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
                  {c.icon ? `${c.icon} ` : ""}
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
        className="form column-form"
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
            resultType={resultType}
            choices={choices}
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

        {type === "relation" && (
          <div className="form panel-box">
            <Field label={t("column.targetTable")}>
              <Select
                value={targetTableId}
                disabled={!!existing}
                onChange={setTargetTableId}
                options={tables.map((table) => ({
                  value: table.id,
                  label:
                    table.id === activeTableId
                      ? `${table.name}${t("column.selfRelation")}`
                      : table.name,
                }))}
              />
            </Field>
            <Checkbox checked={single} onChange={setSingle}>
              {t("column.singleRelation")}
            </Checkbox>
            {!existing && (
              <Field label={t("column.reverseName")}>
                <Input
                  value={reverseName}
                  placeholder={t("column.noReverse")}
                  onChange={(e) => setReverseName(e.target.value)}
                />
              </Field>
            )}
            <p className="hint">{t("column.relationHint")}</p>
          </div>
        )}

        {type === "formula" && (
          <div className="form panel-box">
            <Field label={t("column.formulaExpr")}>
              <Textarea
                rows={3}
                value={formulaExpr}
                placeholder={t("column.formulaPlaceholder")}
                onChange={(e) => setFormulaExpr(e.target.value)}
              />
            </Field>
            <div className="ref-chips">
              {referenceable.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="chip"
                  title={t("column.insertRef")}
                  onClick={() => setFormulaExpr((expr) => expr + `[${c.name}]`)}
                >
                  [{c.name}]
                </button>
              ))}
            </div>
            <Field label={t("column.resultType")}>
              <Select
                value={resultType}
                onChange={(v) => setResultType(v as FormulaResultType)}
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
              <Checkbox
                checked={defaultEnabled}
                disabled={defaultBlocked}
                onChange={toggleDefault}
              >
                {t("column.defaultEnable")}
              </Checkbox>
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
