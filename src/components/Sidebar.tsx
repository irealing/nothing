import { useRef, useState } from "react";
import * as ipc from "../ipc";
import { baseName, useWorkspace } from "../stores/workspace";
import { useLayout } from "../stores/layout";
import { ChangePasswordDialog, CreateTableDialog } from "./dialogs";
import StartActions from "./StartActions";
import ImportCsvDialog from "./ImportCsvDialog";
import { confirm } from "../ui/ConfirmDialog";
import { t } from "../i18n";
import {
  IconCode,
  IconDatabase,
  IconKey,
  IconLogout,
  IconPencil,
  IconPlus,
  IconSidebarCollapse,
  IconSidebarExpand,
  IconTable,
  IconTags,
  IconTrash,
  IconUpload,
} from "./icons";
import { ThemeSwitch, SchemeSwitch } from "../ui/ThemeSwitch";
import { Tooltip } from "../ui/Tooltip";
import { EmojiMenu, ColorSwatches } from "../ui/ColumnPickers";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { Popover } from "../ui/Popover";
import { cellStyle, isPresetColor } from "../theme/grid";
import { VersionChip } from "./AboutDialog";
import type { ColumnColor, TableMeta } from "../types";

export default function Sidebar() {
  const info = useWorkspace((s) => s.info);
  const tables = useWorkspace((s) => s.tables);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const selectTable = useWorkspace((s) => s.selectTable);
  const renameTable = useWorkspace((s) => s.renameTable);
  const setTableIcon = useWorkspace((s) => s.setTableIcon);
  const setTableColor = useWorkspace((s) => s.setTableColor);
  const deleteTable = useWorkspace((s) => s.deleteTable);
  const openScratch = useWorkspace((s) => s.openScratch);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);
  const collapsed = useLayout((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayout((s) => s.toggleSidebar);

  const [showCreateTable, setShowCreateTable] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menu, setMenu] = useState<{ table: TableMeta; x: number; y: number } | null>(null);
  const [colorTarget, setColorTarget] = useState<{ tableId: string; x: number; y: number } | null>(
    null,
  );
  // Custom (hex) colours are previewed locally and only written on "完成";
  // preset picks write immediately.
  const [colorDraft, setColorDraft] = useState<ColumnColor | null>(null);
  // Escape (or a programmatic blur) must not re-submit a rename.
  const skipRenameBlur = useRef(false);

  const colorTable = colorTarget ? (tables.find((t) => t.id === colorTarget.tableId) ?? null) : null;

  const startRename = (table: TableMeta) => {
    skipRenameBlur.current = false;
    setRenaming(table.id);
    setRenameValue(table.name);
  };

  const commitRename = (table: TableMeta) => {
    const value = renameValue.trim();
    setRenaming(null);
    if (value && value !== table.name) void renameTable(table.id, value);
  };

  const removeTable = (table: TableMeta) => {
    void confirm({
      title: t("sidebar.deleteTable"),
      description: t("sidebar.deleteTableConfirm", { name: table.name }),
      confirmLabel: t("common.delete"),
      danger: true,
    }).then((ok) => {
      if (ok) void deleteTable(table.id);
    });
  };

  const pickColor = (color: ColumnColor | null) => {
    if (!colorTable) return;
    if (color === null || isPresetColor(color)) {
      void setTableColor(colorTable.id, color);
      setColorTarget(null);
    } else {
      setColorDraft(color);
    }
  };

  const commitColorDraft = () => {
    if (!colorTable) return;
    if (colorDraft !== colorTable.color) void setTableColor(colorTable.id, colorDraft);
    setColorTarget(null);
  };

  const startImport = async () => {
    try {
      const picked = await ipc.pickCsvFile();
      if (picked) setImportPath(picked);
    } catch {
      // The native dialog failing is non-fatal; keep the UI as-is.
    }
  };

  return (
    <aside className={collapsed ? "sidebar collapsed" : "sidebar"}>
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
          {!collapsed && (
            <>
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
            </>
          )}
          <Tooltip label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}>
            <button
              className="btn-icon sidebar-toggle"
              aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
              aria-expanded={!collapsed}
              onClick={toggleSidebar}
            >
              {collapsed ? <IconSidebarExpand size={15} /> : <IconSidebarCollapse size={15} />}
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
          {tables.map((table) => {
            const tint = table.color ? cellStyle(table.color).background : undefined;
            return (
              <li
                key={table.id}
                className={table.id === activeTableId ? "nav-item active" : "nav-item"}
                title={collapsed ? table.name : undefined}
                aria-current={table.id === activeTableId ? "page" : undefined}
                onClick={() => void selectTable(table.id)}
                onDoubleClick={() => {
                  if (collapsed) return;
                  startRename(table);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ table, x: e.clientX, y: e.clientY });
                }}
              >
                {collapsed ? (
                  <span
                    className="nav-icon nav-icon-static"
                    style={tint ? { background: tint } : undefined}
                  >
                    {table.icon ? (
                      <span className="nav-emoji">{table.icon}</span>
                    ) : (
                      <IconTable size={14} />
                    )}
                  </span>
                ) : (
                  <EmojiMenu
                    value={table.icon}
                    onChange={(icon) => void setTableIcon(table.id, icon)}
                    trigger={
                      <button
                        type="button"
                        className="nav-icon nav-icon-btn"
                        style={tint ? { background: tint } : undefined}
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
                )}
                {renaming === table.id ? (
                  <input
                    className="nav-rename"
                    value={renameValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => {
                      if (skipRenameBlur.current) {
                        skipRenameBlur.current = false;
                        return;
                      }
                      commitRename(table);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        // Let blur do the single commit below.
                        e.currentTarget.blur();
                      }
                      if (e.key === "Escape") {
                        skipRenameBlur.current = true;
                        // Consume the flag synchronously; blur may not fire on unmount.
                        e.currentTarget.blur();
                        setRenaming(null);
                      }
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
                      removeTable(table);
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </li>
            );
          })}
          {tables.length === 0 && (
            <li className="nav-empty">
              <span className="nav-empty-icon">
                <IconTable size={20} />
              </span>
              <p>{t("sidebar.noTables")}</p>
              <StartActions className="start-actions stacked" />
            </li>
          )}
        </ul>
      </div>

      <div className="sidebar-foot">
        <div className="sidebar-foot-row">
          <ThemeSwitch />
          <Tooltip label={t("sql.scratch")}>
            <button
              className="btn-icon"
              aria-label={t("sql.scratch")}
              onClick={() => openScratch()}
            >
              <IconCode size={15} />
            </button>
          </Tooltip>
        </div>
        <SchemeSwitch />
        <p className="nav-hint">{t("sidebar.renameHint")}</p>
        <div className="sidebar-foot-meta">
          <VersionChip />
        </div>
      </div>

      {menu && (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
          trigger={
            <span
              className="virtual-anchor"
              style={{ left: menu.x, top: menu.y }}
              aria-hidden
            />
          }
        >
          <MenuItem
            onSelect={() => {
              startRename(menu.table);
              setMenu(null);
            }}
          >
            <IconPencil size={14} /> {t("sidebar.renameTable")}
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setColorDraft(menu.table.color);
              setColorTarget({ tableId: menu.table.id, x: menu.x, y: menu.y });
              setMenu(null);
            }}
          >
            <IconTags size={14} /> {t("column.color")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            onSelect={() => {
              removeTable(menu.table);
              setMenu(null);
            }}
          >
            <IconTrash size={14} /> {t("sidebar.deleteTable")}
          </MenuItem>
        </Menu>
      )}

      {colorTarget && colorTable && (
        <Popover
          open
          onOpenChange={(open) => {
            if (!open) setColorTarget(null);
          }}
          trigger={
            <span
              className="virtual-anchor"
              style={{ left: colorTarget.x, top: colorTarget.y }}
              aria-hidden
            />
          }
        >
          <ColorSwatches
            value={colorDraft}
            onChange={pickColor}
            onDone={commitColorDraft}
          />
        </Popover>
      )}

      {showCreateTable && <CreateTableDialog onClose={() => setShowCreateTable(false)} />}
      {showChangePw && <ChangePasswordDialog onClose={() => setShowChangePw(false)} />}
      {importPath && <ImportCsvDialog path={importPath} onClose={() => setImportPath(null)} />}
    </aside>
  );
}
