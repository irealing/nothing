import { useState } from "react";
import * as ipc from "../ipc";
import { baseName, useWorkspace } from "../stores/workspace";
import { ChangePasswordDialog, CreateTableDialog } from "./dialogs";
import ImportCsvDialog from "./ImportCsvDialog";
import { confirm } from "../ui/ConfirmDialog";
import { t } from "../i18n";
import {
  IconDatabase,
  IconKey,
  IconLogout,
  IconPlus,
  IconTable,
  IconTrash,
  IconUpload,
} from "./icons";
import { ThemeSwitch } from "../ui/ThemeSwitch";
import { Tooltip } from "../ui/Tooltip";
import { EmojiMenu } from "../ui/ColumnPickers";

export default function Sidebar() {
  const info = useWorkspace((s) => s.info);
  const tables = useWorkspace((s) => s.tables);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const selectTable = useWorkspace((s) => s.selectTable);
  const renameTable = useWorkspace((s) => s.renameTable);
  const setTableIcon = useWorkspace((s) => s.setTableIcon);
  const deleteTable = useWorkspace((s) => s.deleteTable);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);

  const [showCreateTable, setShowCreateTable] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startImport = async () => {
    try {
      const picked = await ipc.pickCsvFile();
      if (picked) setImportPath(picked);
    } catch {
      // The native dialog failing is non-fatal; keep the UI as-is.
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header" title={info?.path}>
        <div className="sidebar-ws">
          <span className="ws-mark">
            <IconDatabase size={15} />
          </span>
          <div className="ws-meta">
            <span className="ws-name">{info ? baseName(info.path) : ""}</span>
            <span className="ws-sub">{t("sidebar.encrypted")}</span>
          </div>
        </div>
        <div className="sidebar-actions">
          <Tooltip label={t("sidebar.changePassword")}>
            <button className="btn-icon" onClick={() => setShowChangePw(true)}>
              <IconKey size={15} />
            </button>
          </Tooltip>
          <Tooltip label={t("sidebar.closeWorkspace")}>
            <button className="btn-icon" onClick={() => void closeWorkspace()}>
              <IconLogout size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span className="section-title">
            {t("sidebar.tables")}
            {tables.length > 0 && <span className="section-count">{tables.length}</span>}
          </span>
          <span className="section-actions">
            <button className="btn-icon" title={t("sidebar.newTable")} onClick={() => setShowCreateTable(true)}>
              <IconPlus size={14} />
            </button>
            <Tooltip label={t("importCsv.action")}>
              <button className="btn-icon" onClick={() => void startImport()}>
                <IconUpload size={14} />
              </button>
            </Tooltip>
          </span>
        </div>
        <ul className="nav-list">
          {tables.map((table) => (
            <li
              key={table.id}
              className={table.id === activeTableId ? "nav-item active" : "nav-item"}
              onClick={() => void selectTable(table.id)}
              onDoubleClick={() => {
                setRenaming(table.id);
                setRenameValue(table.name);
              }}
            >
              <EmojiMenu
                value={table.icon}
                onChange={(icon) => void setTableIcon(table.id, icon)}
                trigger={
                  <button
                    type="button"
                    className="nav-icon nav-icon-btn"
                    aria-label={t("table.icon")}
                    title={t("table.icon")}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    {table.icon ? (
                      <span className="nav-emoji">{table.icon}</span>
                    ) : (
                      <IconTable size={14} />
                    )}
                  </button>
                }
              />
              {renaming === table.id ? (
                <input
                  className="nav-rename"
                  value={renameValue}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const v = renameValue.trim();
                      setRenaming(null);
                      if (v && v !== table.name) void renameTable(table.id, v);
                    }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="nav-label">{table.name}</span>
              )}
              {table.id === activeTableId && renaming !== table.id && (
                <button
                  className="nav-action danger"
                  title={t("sidebar.deleteTable")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void confirm({
                      title: t("sidebar.deleteTable"),
                      description: t("sidebar.deleteTableConfirm", { name: table.name }),
                      confirmLabel: t("common.delete"),
                      danger: true,
                    }).then((ok) => {
                      if (ok) void deleteTable(table.id);
                    });
                  }}
                >
                  <IconTrash size={13} />
                </button>
              )}
            </li>
          ))}
          {tables.length === 0 && (
            <li className="nav-empty">
              <span className="nav-empty-icon">
                <IconTable size={20} />
              </span>
              <p>{t("sidebar.noTables")}</p>
              <button className="btn ghost" onClick={() => setShowCreateTable(true)}>
                <IconPlus size={14} /> {t("sidebar.newTableAction")}
              </button>
              <button className="btn ghost" onClick={() => void startImport()}>
                <IconUpload size={14} /> {t("importCsv.action")}
              </button>
            </li>
          )}
        </ul>
      </div>

      <div className="sidebar-foot">
        <ThemeSwitch />
        <p className="nav-hint">{t("sidebar.renameHint")}</p>
      </div>

      {showCreateTable && <CreateTableDialog onClose={() => setShowCreateTable(false)} />}
      {showChangePw && <ChangePasswordDialog onClose={() => setShowChangePw(false)} />}
      {importPath && <ImportCsvDialog path={importPath} onClose={() => setImportPath(null)} />}
    </aside>
  );
}
