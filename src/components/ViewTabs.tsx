import { useState } from "react";
import { useWorkspace } from "../stores/workspace";
import { Modal } from "./dialogs";
import { SqlEditor } from "./SqlEditor";
import type { ViewMeta } from "../types";

/**
 * View tab bar: the active table's grid views, a separator, then all
 * workspace-level SQL views. "+" creates either kind; the active tab gets a
 * rename/delete menu.
 */
export default function ViewTabs() {
  const views = useWorkspace((s) => s.views);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const selectView = useWorkspace((s) => s.selectView);
  const createGridView = useWorkspace((s) => s.createGridView);
  const createSqlView = useWorkspace((s) => s.createSqlView);
  const updateView = useWorkspace((s) => s.updateView);
  const deleteView = useWorkspace((s) => s.deleteView);

  const [menuOpen, setMenuOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<string | null>(null);
  const [gridDialog, setGridDialog] = useState(false);
  const [sqlDialog, setSqlDialog] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ViewMeta | null>(null);
  const [nameInput, setNameInput] = useState("");

  if (!activeTableId) return null;

  const gridViews = views.filter((v) => v.kind === "grid");
  const sqlViews = views.filter((v) => v.kind === "sql");
  const active = views.find((v) => v.id === activeViewId) ?? null;

  const submitNewGrid = async () => {
    const name = nameInput.trim() || `视图 ${gridViews.length + 1}`;
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
          <span className="view-tab-icon">▤</span>
          <span>{v.name}</span>
          {v.id === activeViewId && (
            <button
              className="btn-icon tab-menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                setTabMenu(tabMenu === v.id ? null : v.id);
              }}
            >
              ▾
            </button>
          )}
        </div>
      ))}
      {gridViews.length > 0 && sqlViews.length > 0 && <div className="view-tabs-sep" />}
      {sqlViews.map((v) => (
        <div
          key={v.id}
          className={v.id === activeViewId ? "view-tab active" : "view-tab"}
          onClick={() => void selectView(v.id)}
          title="SQL 视图（工作区级）"
        >
          <span className="view-tab-icon">⌘</span>
          <span>{v.name}</span>
          {v.id === activeViewId && (
            <button
              className="btn-icon tab-menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                setTabMenu(tabMenu === v.id ? null : v.id);
              }}
            >
              ▾
            </button>
          )}
        </div>
      ))}

      <div className="view-tabs-add">
        <button className="btn-icon" onClick={() => setMenuOpen(!menuOpen)} title="新建视图">
          ＋
        </button>
        {menuOpen && (
          <div className="dropdown-menu" onMouseLeave={() => setMenuOpen(false)}>
            <button
              onClick={() => {
                setMenuOpen(false);
                setNameInput("");
                setGridDialog(true);
              }}
            >
              ▤ 新建网格视图
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                setNameInput("");
                setSqlDialog(true);
              }}
            >
              ⌘ 新建 SQL 视图
            </button>
          </div>
        )}
      </div>

      {tabMenu && active && active.id === tabMenu && (
        <div className="dropdown-menu tab-menu" onMouseLeave={() => setTabMenu(null)}>
          <button
            onClick={() => {
              setTabMenu(null);
              setNameInput(active.name);
              setRenameTarget(active);
            }}
          >
            重命名
          </button>
          <button
            className="danger"
            onClick={() => {
              setTabMenu(null);
              if (window.confirm(`删除视图「${active.name}」？`)) void deleteView(active.id);
            }}
          >
            删除视图
          </button>
        </div>
      )}

      {gridDialog && (
        <Modal title="新建网格视图" onClose={() => setGridDialog(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitNewGrid();
            }}
          >
            <label>
              视图名
              <input
                value={nameInput}
                autoFocus
                placeholder={`视图 ${gridViews.length + 1}`}
                onChange={(e) => setNameInput(e.target.value)}
              />
            </label>
            <button type="submit" className="btn primary">
              创建
            </button>
          </form>
        </Modal>
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
        <Modal title="重命名视图" onClose={() => setRenameTarget(null)}>
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
            <label>
              视图名
              <input value={nameInput} autoFocus onChange={(e) => setNameInput(e.target.value)} />
            </label>
            <button type="submit" className="btn primary">
              保存
            </button>
          </form>
        </Modal>
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
    <Modal title="新建 SQL 视图" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !statement.trim()) return;
          void onCreate(name.trim(), statement.trim());
        }}
      >
        <label>
          视图名
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="例如：任务统计" />
        </label>
        <label>
          SELECT 语句（只读，支持 JOIN / 聚合 / 窗口函数）
          <SqlEditor value={statement} onChange={setStatement} height="160px" />
        </label>
        <p className="hint">
          提示：物理表名形如 t_xxxx，可在网格视图的列菜单里查看「SQL 引用名」。
        </p>
        <button type="submit" className="btn primary">
          创建
        </button>
      </form>
    </Modal>
  );
}
