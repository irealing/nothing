import { useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { t } from "../i18n";
import type { ColumnType, NewColumn } from "../types";
import { Dialog } from "../ui/Dialog";
import { Field, Input, handleFormEnter } from "../ui/Field";
import { Menu, MenuItem } from "../ui/Menu";
import { ColumnTypeIcon, IconChevronDown, IconPlus, IconX } from "./icons";
import { pickAutoColor } from "../theme/grid";
import { EmojiPicker } from "../ui/ColumnPickers";

// Types that can be created straight from the builder. Selects get an inline
// choices field; relation/formula need the table to exist first, so they stay
// in the per-column dialog.
type CreateType = Extract<ColumnType, "text" | "number" | "date" | "checkbox" | "select" | "multi_select">;

const CREATE_TYPES: { value: CreateType; hintKey: "hintText" | "hintNumber" | "hintDate" | "hintCheckbox" | "hintSelect" | "hintMultiSelect" }[] = [
  { value: "text", hintKey: "hintText" },
  { value: "number", hintKey: "hintNumber" },
  { value: "date", hintKey: "hintDate" },
  { value: "checkbox", hintKey: "hintCheckbox" },
  { value: "select", hintKey: "hintSelect" },
  { value: "multi_select", hintKey: "hintMultiSelect" },
];

/** Compact type selector with icon + one-line explanation per type. */
function TypePicker({ value, onChange }: { value: CreateType; onChange: (v: CreateType) => void }) {
  return (
    <Menu
      ariaLabel={t("column.type")}
      trigger={
        <button type="button" className="type-picker-btn">
          <ColumnTypeIcon type={value} size={14} />
          <span>{t(`types.${value}`)}</span>
          <IconChevronDown size={12} className="type-picker-caret" />
        </button>
      }
    >
      {CREATE_TYPES.map((item) => (
        <MenuItem key={item.value} onSelect={() => onChange(item.value)}>
          <span className="type-picker-icon">
            <ColumnTypeIcon type={item.value} size={15} />
          </span>
          <span className="type-picker-text">
            <span className="type-picker-label">{t(`types.${item.value}`)}</span>
            <span className="type-picker-hint">{t(`types.${item.hintKey}`)}</span>
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}

interface ExtraCol {
  key: string;
  name: string;
  type: CreateType;
  choices: string;
}

function newExtra(): ExtraCol {
  return { key: crypto.randomUUID(), name: "", type: "text", choices: "" };
}

export function CreateTableDialog({ onClose }: { onClose: () => void }) {
  const createTable = useWorkspace((s) => s.createTable);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [titleCol, setTitleCol] = useState(t("createTable.titleColumnPlaceholder"));
  const [extras, setExtras] = useState<ExtraCol[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError(t("createTable.nameRequired"));
    if (!titleCol.trim()) return setError(t("createTable.titleColumnRequired"));
    if (extras.some((e) => !e.name.trim())) return setError(t("createTable.columnNamesRequired"));
    setError(null);
    setBusy(true);
    try {
      const columns: NewColumn[] = [
        { name: titleCol.trim(), type: "text" },
        ...extras.map((e): NewColumn => {
          if (e.type === "select" || e.type === "multi_select") {
            const names = e.choices
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean);
            const used: string[] = [];
            const choices = names.map((n) => {
              const color = pickAutoColor(used);
              used.push(color);
              return { id: crypto.randomUUID(), name: n, color };
            });
            return { name: e.name.trim(), type: e.type, choices };
          }
          return { name: e.name.trim(), type: e.type };
        }),
      ];
      await createTable(name.trim(), columns, icon);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const patch = (key: string, next: Partial<ExtraCol>) =>
    setExtras((list) => list.map((e) => (e.key === key ? { ...e, ...next } : e)));

  return (
    <Dialog title={t("createTable.title")} subtitle={t("createTable.subtitle")} onClose={onClose} wide>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => handleFormEnter(e, () => void submit())}
      >
        <div className="form-grid">
          <Field label={t("createTable.tableName")}>
            <div className="table-name-row">
              <EmojiPicker value={icon} onChange={setIcon} />
              <Input
                value={name}
                data-enter-submit="true"
                onChange={(e) => setName(e.target.value)}
                placeholder={t("createTable.tableNamePlaceholder")}
                autoFocus
              />
            </div>
          </Field>
          <Field label={t("createTable.titleColumn")}>
            <Input
              value={titleCol}
              onChange={(e) => setTitleCol(e.target.value)}
              placeholder={t("createTable.titleColumnPlaceholder")}
            />
          </Field>
        </div>

        <div className="builder">
          <div className="builder-head">
            <span>{t("createTable.otherColumns")}</span>
            <span className="builder-count">{t("createTable.columnCount", { count: extras.length })}</span>
          </div>

          <div className="builder-row builder-row-fixed">
            <span className="builder-name builder-name-fixed">
              <ColumnTypeIcon type="text" size={14} />
              {t("createTable.titleColumnFixed")}
            </span>
            <span className="builder-locked">{t("types.text")}</span>
          </div>

          {extras.map((ex) => (
            <div className="builder-block" key={ex.key}>
              <div className="builder-row">
                <Input
                  className="ui-input builder-name"
                  placeholder={t("createTable.columnNamePlaceholder")}
                  value={ex.name}
                  onChange={(e) => patch(ex.key, { name: e.target.value })}
                />
                <TypePicker
                  value={ex.type}
                  onChange={(v) =>
                    patch(ex.key, { type: v, choices: v === "select" || v === "multi_select" ? ex.choices : "" })
                  }
                />
                <button
                  type="button"
                  className="btn-icon danger"
                  title={t("createTable.removeColumn")}
                  onClick={() => setExtras((list) => list.filter((e) => e.key !== ex.key))}
                >
                  <IconX size={14} />
                </button>
              </div>
              {(ex.type === "select" || ex.type === "multi_select") && (
                <Input
                  className="ui-input builder-choices"
                  placeholder={t("createTable.choicesPlaceholder")}
                  value={ex.choices}
                  onChange={(e) => patch(ex.key, { choices: e.target.value })}
                />
              )}
            </div>
          ))}

          <button type="button" className="btn dashed" onClick={() => setExtras((l) => [...l, newExtra()])}>
            <IconPlus size={14} /> {t("createTable.addColumn")}
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <p className="hint">{t("createTable.hint")}</p>
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {busy ? t("createTable.creating") : t("createTable.createAction")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const changePassword = useWorkspace((s) => s.changePassword);
  const [pw, setPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!pw) return setErr(t("password.empty"));
    if (pw !== confirmPw) return setErr(t("password.mismatch"));
    setErr(null);
    await changePassword(pw);
    onClose();
  };

  return (
    <Dialog title={t("password.title")} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t("password.newPassword")}>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        <Field label={t("password.confirmNewPassword")}>
          <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
        </Field>
        {err && <div className="form-error">{err}</div>}
        <p className="hint">{t("password.hint")}</p>
        <div className="modal-actions">
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary">
            {t("password.action")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}