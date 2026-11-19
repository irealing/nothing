import { useState } from "react";
import { pickNewWorkspacePath, pickWorkspaceFile } from "../ipc";
import { useWorkspace } from "../stores/workspace";

export default function Welcome() {
  const openWorkspace = useWorkspace((s) => s.openWorkspace);
  const createWorkspace = useWorkspace((s) => s.createWorkspace);
  const storeError = useWorkspace((s) => s.error);

  const [mode, setMode] = useState<"open" | "create">("open");
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const browse = async () => {
    const p = mode === "open" ? await pickWorkspaceFile() : await pickNewWorkspacePath();
    if (p) setPath(p);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!path.trim()) return setLocalError("请选择工作区文件路径");
    if (!password) return setLocalError("请输入密码");
    if (mode === "create" && password !== confirm) {
      return setLocalError("两次输入的密码不一致");
    }
    setBusy(true);
    try {
      if (mode === "open") {
        await openWorkspace(path.trim(), password);
      } else {
        await createWorkspace(path.trim(), password);
      }
    } finally {
      setBusy(false);
    }
  };

  const error = localError ?? storeError;

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand">
          <div className="brand-logo" aria-hidden />
          <h1>nothing</h1>
        </div>
        <p className="brand-sub">本地优先、端到端加密的表格工作区</p>

        <div className="tabs">
          <button
            className={mode === "open" ? "tab active" : "tab"}
            onClick={() => { setMode("open"); setLocalError(null); }}
          >
            打开工作区
          </button>
          <button
            className={mode === "create" ? "tab active" : "tab"}
            onClick={() => { setMode("create"); setLocalError(null); }}
          >
            新建工作区
          </button>
        </div>

        <form onSubmit={submit} className="form">
          <label>
            文件
            <div className="path-row">
              <input
                type="text"
                value={path}
                placeholder={mode === "open" ? "选择 .nothing 文件" : "选择保存位置（.nothing）"}
                onChange={(e) => setPath(e.target.value)}
              />
              <button type="button" className="btn" onClick={browse}>
                浏览…
              </button>
            </div>
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {mode === "create" && (
            <>
              <label>
                确认密码
                <input
                  type="password"
                  value={confirm}
                  autoComplete="off"
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              <p className="hint">
                工作区使用 SQLCipher 加密。密码丢失将无法恢复数据，请牢记。
              </p>
            </>
          )}
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "处理中…" : mode === "open" ? "打开" : "创建"}
          </button>
        </form>
      </div>
    </div>
  );
}
