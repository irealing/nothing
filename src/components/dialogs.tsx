import { useState } from "react";
import { useWorkspace } from "../stores/workspace";
import type { ColumnType, NewColumn } from "../types";

/** Minimal modal shell (function components only — AGENTS.md). */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// M3 支持直接创建的基础类型；select / relation / formula 的编辑器在 M4 提供
// （届时通过列菜单与专门对话框创建）。
const BASIC_TYPES: { value: ColumnType; label: string }[] = [
  { value: "text", label: "文本" },
  { value: "number", label: "数字" },
  { value: "date", label: "日期" },
  { value: "checkbox", label: "复选框" },
];

interface ExtraCol {
  name: string;
  type: ColumnType;
}

export function CreateTableDialog({ onClose }: { onClose: () => void }) {
  const createTable = useWorkspace((s) => s.createTable);
  const [name, setName] = useState("");
  const [titleCol, setTitleCol] = useState("标题");
  const [extras, setExtras] = useState<ExtraCol[]>([]);

  const submit = async () => {
    if (!name.trim() || !titleCol.trim()) return;
    const columns: NewColumn[] = [
      { name: titleCol.trim(), type: "text" },
      ...extras
        .filter((e) => e.name.trim())
        .map((e) => ({ name: e.name.trim(), type: e.type })),
    ];
    await createTable(name.trim(), columns);
    onClose();
  };

  return (
    <Modal title="新建表格" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          表名
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：任务" autoFocus />
        </label>
        <label>
          标题列（文本，作为行的显示名）
          <input value={titleCol} onChange={(e) => setTitleCol(e.target.value)} />
        </label>
        <div className="extra-cols">
          {extras.map((ex, i) => (
            <div className="extra-col-row" key={i}>
              <input
                placeholder="列名"
                value={ex.name}
                onChange={(e) => {
                  const next = [...extras];
                  next[i] = { ...ex, name: e.target.value };
                  setExtras(next);
                }}
              />
              <select
                value={ex.type}
                onChange={(e) => {
                  const next = [...extras];
                  next[i] = { ...ex, type: e.target.value as ColumnType };
                  setExtras(next);
                }}
              >
                {BASIC_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-icon danger"
                onClick={() => setExtras(extras.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setExtras([...extras, { name: "", type: "number" }])}
          >
            ＋ 添加列
          </button>
        </div>
        <button type="submit" className="btn primary">
          创建
        </button>
      </form>
    </Modal>
  );
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const changePassword = useWorkspace((s) => s.changePassword);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!pw) return setErr("新密码不能为空");
    if (pw !== confirm) return setErr("两次输入不一致");
    await changePassword(pw);
    onClose();
  };

  return (
    <Modal title="修改工作区密码" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          新密码
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </label>
        <label>
          确认新密码
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {err && <div className="form-error">{err}</div>}
        <p className="hint">整个数据库文件会用新密码重新加密，可能需要一点时间。</p>
        <button type="submit" className="btn primary">
          修改
        </button>
      </form>
    </Modal>
  );
}
