// SQL view workspace: CodeMirror editor, 运行 (ad-hoc preview via read-only
// connection) and 保存 (persist as the view's statement, recreating the real
// CREATE VIEW object on the backend).

import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import { SqlEditor } from "./SqlEditor";
import SqlResultTable from "./SqlResultTable";
import type { SqlResult, ViewMeta } from "../types";

export default function SqlViewPanel({ view }: { view: ViewMeta }) {
  const updateView = useWorkspace((s) => s.updateView);
  const storedResult = useWorkspace((s) => s.sqlResult);

  const stored = view.config.kind === "sql" ? view.config.statement : "";
  const [statement, setStatement] = useState(stored);
  const [preview, setPreview] = useState<SqlResult | null>(null);
  const [running, setRunning] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setStatement(view.config.kind === "sql" ? view.config.statement : "");
    setPreview(null);
    setPreviewError(null);
  }, [view.id, view.config]);

  const dirty = statement.trim() !== stored.trim();

  const run = async () => {
    setRunning(true);
    setPreviewError(null);
    try {
      const result = await ipc.runSql(statement, 1000, 0);
      setPreview(result);
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    await updateView(view.id, { config: { kind: "sql", statement } });
    setPreview(null);
  };

  return (
    <div className="sql-view">
      <div className="toolbar">
        <h2 className="toolbar-title">⌘ {view.name}</h2>
        <span className="toolbar-count">只读执行 · 支持 JOIN / 聚合 / 窗口函数</span>
        <div className="toolbar-spacer" />
        <button className="btn" disabled={running} onClick={() => void run()}>
          {running ? "运行中…" : "▶ 运行"}
        </button>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
          保存{dirty ? " ●" : ""}
        </button>
      </div>
      <div className="sql-editor-wrap">
        <SqlEditor value={statement} onChange={setStatement} height="180px" />
      </div>
      {previewError && <div className="form-error sql-error">{previewError}</div>}
      <div className="sql-result-wrap">
        <SqlResultTable result={preview ?? (dirty ? null : storedResult)} />
      </div>
    </div>
  );
}
