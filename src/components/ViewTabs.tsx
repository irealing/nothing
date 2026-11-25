import { useRef, useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { Dialog } from "../ui/Dialog";
import { Field, Input } from "../ui/Field";
import { Menu, MenuItem, MenuSeparator, MenuSub } from "../ui/Menu";
import { EMOJI_CHOICES } from "../ui/ColumnPickers";
import { confirm } from "../ui/ConfirmDialog";
import { t } from "../i18n";
import { SqlEditor } from "./SqlEditor";
import {
  IconChevronDown,
  IconCode,
  IconEmoji,
  IconGridView,
  IconPencil,
  IconPlus,
  IconPlay,
  IconSigma,
  IconTrash,
  IconX,
} from "./icons";
import { isAggregateView, type ViewMeta } from "../types";

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
  const createAggregateView = useWorkspace((s) => s.createAggregateView);
  const createSqlView = useWorkspace((s) => s.createSqlView);
  const updateView = useWorkspace((s) => s.updateView);
  const deleteView = useWorkspace((s) => s.deleteView);

  const [gridDialog, setGridDialog] = useState(false);
  const [aggregateDialog, setAggregateDialog] = useState(false);
  const [sqlDialog, setSqlDialog] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [nameInput, setNameInput] = useState("");
  const skipRenameBlur = useRef(false);

  const pickViewIcon = (view: ViewMeta, icon: string | null) =>
    void updateView(view.id, { icon: icon ?? "" });

  const tabIcon = (view: ViewMeta) =>
    view.icon ? (
      <span className="view-tab-emoji">{view.icon}</span>
    ) : view.kind === "sql" ? (
      <IconCode size={13} />
    ) : isAggregateView(view) ? (
      <IconSigma size={13} />
    ) : (
      <IconGridView size={13} />
    );

  const gridViews = views.filter((v) => v.kind === "grid");
  const dataGridViews = gridViews.filter((v) => !isAggregateView(v));
  const sqlViews = views.filter((v) => v.kind === "sql");
  // A table's implicit default view is recreated on demand. Deleting the last
  // *editable* grid view would just bring it back under the default name, so
  // there is nothing meaningful to offer there (summary views are exempt).
  const canDeleteGrid = dataGridViews.length > 1;

  if (!activeTableId && sqlViews.length === 0) return null;

  const submitNewGrid = async () => {
    const name = nameInput.trim() || t("view.namePlaceholder", { n: gridViews.length + 1 });
    setGridDialog(false);
    setNameInput("");
    await createGridView(name);
  };

  const submitNewAggregate = async () => {
    const name =
      nameInput.trim() || `${t("aggregate.title")} ${gridViews.length + 1}`;
    setAggregateDialog(false);
    setNameInput("");
    await createAggregateView(name);
  };

  const startRename = (v: ViewMeta) => {
    skipRenameBlur.current = false;
    setRenameValue(v.name);
    setRenamingId(v.id);
  };

  const commitRename = (v: ViewMeta) => {
    if (renamingId !== v.id) return;
    const name = renameValue.trim();
    setRenamingId(null);
    if (name && name !== v.name) void updateView(v.id, { name });
  };

  /** Tab label: swaps to an inline input while renaming (same as the sidebar). */
  const tabLabel = (v: ViewMeta) =>
    renamingId === v.id ? (
      <input
        className="view-tab-rename"
        value={renameValue}
        autoFocus
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={() => {
          if (skipRenameBlur.current) {
            skipRenameBlur.current = false;
            return;
          }
          commitRename(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            skipRenameBlur.current = true;
            // Consume the flag synchronously; blur may not fire on unmount.
            e.currentTarget.blur();
            setRenamingId(null);
          }
        }}
      />
    ) : (
      <span>{v.name}</span>
    );

  /** Nested emoji palette: staying inside the menu avoids a second floating
   * layer that Radix would immediately dismiss as an outside click. */
  const iconMenu = (v: ViewMeta) => (
    <MenuSub
      label={
        <>
          <IconEmoji size={14} /> {t("view.icon")}
        </>
      }
      ariaLabel={t("view.icon")}
      contentClassName="ui-menu-emoji"
    >
      {v.icon && (
        <MenuItem className="clear" onSelect={() => pickViewIcon(v, null)}>
          <IconX size={14} /> {t("column.clearIcon")}
        </MenuItem>
      )}
      {EMOJI_CHOICES.map((icon) => (
        <MenuItem key={icon} onSelect={() => pickViewIcon(v, icon)}>
          {icon}
        </MenuItem>
      ))}
    </MenuSub>
  );

  return (
    <div className="view-tabs">
      {gridViews.map((v) => (
        <div
          key={v.id}
          className={v.id === activeViewId ? "view-tab active" : "view-tab"}
          onClick={() => void selectView(v.id)}
        >
          <span className="view-tab-icon">{tabIcon(v)}</span>
          {tabLabel(v)}
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
              {iconMenu(v)}
              <MenuItem onSelect={() => startRename(v)}>
                <IconPencil size={14} /> {t("view.rename")}
              </MenuItem>
              {isAggregateView(v) || canDeleteGrid ? (
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
              ) : null}
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
          <span className="view-tab-icon">{tabIcon(v)}</span>
          {tabLabel(v)}
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
              {iconMenu(v)}
              <MenuItem onSelect={() => startRename(v)}>
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
            <>
              <MenuItem
                onSelect={() => {
                  setNameInput("");
                  setGridDialog(true);
                }}
              >
                <IconGridView size={14} /> {t("view.newGrid")}
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  setNameInput("");
                  setAggregateDialog(true);
                }}
              >
                <IconSigma size={14} /> {t("aggregate.newTitle")}
              </MenuItem>
            </>
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

      {aggregateDialog && (
        <Dialog title={t("aggregate.newTitle")} onClose={() => setAggregateDialog(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitNewAggregate();
            }}
          >
            <Field label={t("view.name")}>
              <Input
                autoFocus
                value={nameInput}
                placeholder={t("aggregate.namePlaceholder")}
                onChange={(e) => setNameInput(e.target.value)}
              />
            </Field>
            <p className="hint">{t("aggregate.createHint")}</p>
            <div className="modal-actions">
              <div className="toolbar-spacer" />
              <button type="button" className="btn" onClick={() => setAggregateDialog(false)}>
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