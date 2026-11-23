import { useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { Dialog } from "../ui/Dialog";
import { Field, Input } from "../ui/Field";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { confirm } from "../ui/ConfirmDialog";
import { t } from "../i18n";
import { SqlEditor } from "./SqlEditor";
import { IconChevronDown, IconCode, IconGridView, IconPencil, IconPlus, IconPlay, IconTrash } from "./icons";
import type { ViewMeta } from "../types";

/**
 * View tab bar: the active table's grid views, a separator, then all
 * workspace-level SQL views. "+" creates either kind; the active tab gets a
 * rename/delete menu.
 *
 * The menus are portalled (Radix), so the strip's `overflow-x: auto` no longer
 * swallows them — that was why "add view" looked missing.
 */
export default function ViewTabs({ hasTable }: { hasTable: boolean }) {
  const views = useWorkspace((s) => s.views);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const selectView = useWorkspace((s) => s.selectView);
  const createGridView = useWorkspace((s) => s.createGridView);
  const createSqlView = useWorkspace((s) => s.createSqlView);
  const updateView = useWorkspace((s) => s.updateView);
  const deleteView = useWorkspace((s) => s.deleteView);

  const [gridDialog, setGridDialog] = useState(false);
  const [sqlDialog, setSqlDialog] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ViewMeta | null>(null);
  const [nameInput, setNameInput] = useState("");

  const gridViews = views.filter((v) => v.kind === "grid");
  const sqlViews = views.filter((v) => v.kind === "sql");
  // A table's implicit default view is recreated on demand. Deleting the last
  // grid view would just bring it back under the default name, so there is
  // nothing meaningful to offer there.
  const canDeleteGrid = gridViews.length > 1;

  if (!activeTableId && sqlViews.length === 0) return null;

  const submitNewGrid = async () => {
    const name = nameInput.trim() || t("view.namePlaceholder", { n: gridViews.length + 1 });
    setGridDialog(false);
    setNameInput("");
    await createGridView(name);
  };

  return (
    <div className="view-tabs">
      {gridViews.map((v) => (
        <div
          key={v.id}
          className={v.id === activeViewId ? "view-tab active" : "view-tab"}
          onClick={() => void selectView(v.id)}
        >
          <span className="view-tab-icon">
            <IconGridView size={13} />
          </span>
          <span>{v.name}</span>
          {v.id === activeViewId && (
            <Menu
              align="end"
              ariaLabel={t("view.rename")}
              trigger={
                <button
                  className="btn-icon tab-menu-btn"
                  aria-label={t("view.rename")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconChevronDown size={12} />
                </button>
              }
            >
              <MenuItem
                onSelect={() => {
                  setNameInput(v.name);
                  setRenameTarget(v);
                }}
              >
                <IconPencil size={14} /> {t("view.rename")}
              </MenuItem>
              {canDeleteGrid && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    onSelect={() => {
                      void confirm({
                        title: t("view.deleteTitle"),
                        description: t("view.deleteConfirm", { name: v.name }),
                        confirmLabel: t("common.delete"),
                        danger: true,
                      }).then((ok) => {
                        if (ok) void deleteView(v.id);
                      });
                    }}
                  >
                    <IconTrash size={14} /> {t("view.delete")}
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
      ))}
      {gridViews.length > 0 && sqlViews.length > 0 && <div className="view-tabs-sep" />}
      {sqlViews.map((v) => (
        <div
          key={v.id}
          className={v.id === activeViewId ? "view-tab active" : "view-tab"}
          onClick={() => void selectView(v.id)}
          title={t("view.sqlBadge")}
        >
          <span className="view-tab-icon">
            <IconCode size={13} />
          </span>
          <span>{v.name}</span>
          {v.id === activeViewId && (
            <Menu
              align="end"
              trigger={
                <button
                  className="btn-icon tab-menu-btn"
                  aria-label={t("view.rename")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconChevronDown size={12} />
                </button>
              }
            >
              <MenuItem
                onSelect={() => {
                  setNameInput(v.name);
                  setRenameTarget(v);
                }}
              >
                <IconPencil size={14} /> {t("view.rename")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  void confirm({
                    title: t("view.delete"),
                    description: t("view.deleteConfirm", { name: v.name }),
                    confirmLabel: t("common.delete"),
                    danger: true,
                  }).then((ok) => {
                    if (ok) void deleteView(v.id);
                  });
                }}
              >
                <IconTrash size={14} /> {t("view.delete")}
              </MenuItem>
            </Menu>
          )}
        </div>
      ))}

      <div className="view-tabs-add">
        <Menu
          align="start"
          ariaLabel={t("view.newView")}
          trigger={
            <button className="btn ghost small">
              <IconPlus size={13} /> {t("view.add")}
            </button>
          }
        >
          {hasTable && activeTableId && (
            <MenuItem
              onSelect={() => {
                setNameInput("");
                setGridDialog(true);
              }}
            >
              <IconGridView size={14} /> {t("view.newGrid")}
            </MenuItem>
          )}
          <MenuItem
            onSelect={() => {
              setNameInput("");
              setSqlDialog(true);
            }}
          >
            <IconCode size={14} /> {t("view.newSql")}
          </MenuItem>
        </Menu>
      </div>

      {gridDialog && (
        <Dialog title={t("view.newGrid")} onClose={() => setGridDialog(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitNewGrid();
            }}
          >
            <Field label={t("view.name")}>
              <Input
                autoFocus
                value={nameInput}
                placeholder={t("view.namePlaceholder", { n: gridViews.length + 1 })}
                onChange={(e) => setNameInput(e.target.value)}
              />
            </Field>
            <p className="hint">{t("view.gridHint")}</p>
            <div className="modal-actions">
              <div className="toolbar-spacer" />
              <button type="button" className="btn" onClick={() => setGridDialog(false)}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn primary">
                {t("view.create")}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {sqlDialog && (
        <CreateSqlViewDialog
          onClose={() => setSqlDialog(false)}
          onCreate={async (name, statement) => {
            setSqlDialog(false);
            await createSqlView(name, statement);
          }}
        />
      )}

      {renameTarget && (
        <Dialog title={t("view.renameTitle")} onClose={() => setRenameTarget(null)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              const name = nameInput.trim();
              const target = renameTarget;
              setRenameTarget(null);
              if (name) void updateView(target.id, { name });
            }}
          >
            <Field label={t("view.name")}>
              <Input value={nameInput} autoFocus onChange={(e) => setNameInput(e.target.value)} />
            </Field>
            <div className="modal-actions">
              <div className="toolbar-spacer" />
              <button type="button" className="btn" onClick={() => setRenameTarget(null)}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn primary">
                {t("common.save")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

export function CreateSqlViewDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, statement: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [statement, setStatement] = useState("SELECT ");
  return (
    <Dialog
      title={t("view.newSql")}
      subtitle={t("sql.newViewSubtitle")}
      onClose={onClose}
      wide
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !statement.trim()) return;
          void onCreate(name.trim(), statement.trim());
        }}
      >
        <Field label={t("view.name")}>
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={t("sql.namePlaceholder")}
          />
        </Field>
        <Field label={t("sql.statement")}>
          <SqlEditor value={statement} onChange={setStatement} height="180px" />
        </Field>
        <p className="hint">{t("sql.refHint")}</p>
        <div className="modal-actions">
          <div className="toolbar-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            <IconPlay size={13} /> {t("common.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}