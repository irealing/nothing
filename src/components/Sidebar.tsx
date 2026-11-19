import { useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { AddColumnDialog, ChangePasswordDialog, CreateTableDialog } from "./dialogs";

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export default function Sidebar() {
  const info = useWorkspace((s) => s.info);
  const tables = useWorkspace((s) => s.tables);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const views = useWorkspace((s) => s.views);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const selectTable = useWorkspace((s) => s.selectTable);
  const selectView = useWorkspace((s) => s.selectView);
  const deleteTable = useWorkspace((s) => s.deleteTable);
  const closeWorkspace = useWorkspace((s) => s.closeWorkspace);

  const [showCreateTable, setShowCreateTable] = useState(false);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);

  const activeTable = tables.find((t) => t.id === activeTableId) ?? null;

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
            >
              <span className="nav-icon">▦</span>
              <span className="nav-label">{t.name}</span>
              {t.id === activeTableId && (
                <button
                  className="btn-icon danger"
                  title="删除表"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`确定删除表「${t.name}」？所有行、关联和视图都会一并删除，且不可恢复。`)) {
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
      </div>

      {activeTable && (
        <div className="sidebar-section">
          <div className="sidebar-section-head">
            <span>视图 · {activeTable.name}</span>
            <button className="btn-icon" title="添加列" onClick={() => setShowAddColumn(true)}>
              ＋列
            </button>
          </div>
          <ul className="nav-list">
            <li
              className={activeViewId === null ? "nav-item active" : "nav-item"}
              onClick={() => void selectView(null)}
            >
              <span className="nav-icon">≣</span>
              <span className="nav-label">全部数据</span>
            </li>
            {views.map((v) => (
              <li
                key={v.id}
                className={v.id === activeViewId ? "nav-item active" : "nav-item"}
                onClick={() => void selectView(v.id)}
              >
                <span className="nav-icon">{v.kind === "sql" ? "⌘" : "▤"}</span>
                <span className="nav-label">{v.name}</span>
                {v.table_id === null && <span className="nav-badge">SQL</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showCreateTable && <CreateTableDialog onClose={() => setShowCreateTable(false)} />}
      {showAddColumn && <AddColumnDialog onClose={() => setShowAddColumn(false)} />}
      {showChangePw && <ChangePasswordDialog onClose={() => setShowChangePw(false)} />}
    </aside>
  );
}
