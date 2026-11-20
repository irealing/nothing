import { useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { ChangePasswordDialog, CreateTableDialog } from "./dialogs";

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export default function Sidebar() {
  const info = useWorkspace((s) => s.info);
  const tables = useWorkspace((s) => s.tables);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const selectTable = useWorkspace((s) => s.selectTable);
  const renameTable = useWorkspace((s) => s.renameTable);
  const deleteTable = useWorkspace((s) => s.deleteTable);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);

  const [showCreateTable, setShowCreateTable] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  return (
    <aside className="sidebar">
      <div className="sidebar-header" title={info?.path}>
        <div className="sidebar-ws">
          <span className="ws-dot" aria-hidden />
          <span className="ws-name">{info ? baseName(info.path) : ""}</span>
        </div>
        <div className="sidebar-actions">
          <button className="btn-icon" title="修改密码" onClick={() => setShowChangePw(true)}>
            🔑
          </button>
          <button className="btn-icon" title="关闭工作区" onClick={() => void closeWorkspace()}>
            ⏏
          </button>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span>表格</span>
          <button className="btn-icon" title="新建表" onClick={() => setShowCreateTable(true)}>
            ＋
          </button>
        </div>
        <ul className="nav-list">
          {tables.map((t) => (
            <li
              key={t.id}
              className={t.id === activeTableId ? "nav-item active" : "nav-item"}
              onClick={() => void selectTable(t.id)}
              onDoubleClick={() => {
                setRenaming(t.id);
                setRenameValue(t.name);
              }}
            >
              <span className="nav-icon">▦</span>
              {renaming === t.id ? (
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
                      if (v && v !== t.name) void renameTable(t.id, v);
                    }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="nav-label">{t.name}</span>
              )}
              {t.id === activeTableId && renaming !== t.id && (
                <button
                  className="btn-icon danger"
                  title="删除表"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(
                        `确定删除表「${t.name}」？所有行、关联和视图都会一并删除，且不可恢复。`,
                      )
                    ) {
                      void deleteTable(t.id);
                    }
                  }}
                >
                  🗑
                </button>
              )}
            </li>
          ))}
          {tables.length === 0 && <li className="nav-empty">还没有表格，点 ＋ 创建</li>}
        </ul>
        <p className="nav-hint">双击表名可重命名</p>
      </div>

      {showCreateTable && <CreateTableDialog onClose={() => setShowCreateTable(false)} />}
      {showChangePw && <ChangePasswordDialog onClose={() => setShowChangePw(false)} />}
    </aside>
  );
}
