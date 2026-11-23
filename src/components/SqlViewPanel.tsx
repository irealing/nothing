// SQL view workspace: CodeMirror editor, 运行 (ad-hoc preview via read-only
// connection) and 保存 (persist as the view's statement, recreating the real
// CREATE VIEW object on the backend).

import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import { SqlEditor } from "./SqlEditor";
import SqlResultTable from "./SqlResultTable";
import { IconCode, IconPlay } from "./icons";
import { t } from "../i18n";
import type { SqlResult, ViewMeta } from "../types";

export default function SqlViewPanel({ view }: { view: ViewMeta }) {
  const updateView = useWorkspace((s) => s.updateView);
  const storedResult = useWorkspace((s) => s.sqlResult);

  const stored = view.data.kind === "sql" ? view.data.statement : "";
  const [statement, setStatement] = useState(stored);
  const [preview, setPreview] = useState<SqlResult | null>(null);
  const [running, setRunning] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setStatement(view.data.kind === "sql" ? view.data.statement : "");
    setPreview(null);
    setPreviewError(null);
  }, [view.id, view.data]);

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
    await updateView(view.id, { data: { kind: "sql", statement } });
    setPreview(null);
  };

  return (
    <div className="sql-view">
      <div className="toolbar">
        <div className="toolbar-title-group">
          <h2 className="toolbar-title">
            <IconCode size={16} /> {view.name}
          </h2>
          <span className="pill-count">{t("sql.readonly")}</span>
        </div>
        <span className="toolbar-count">{t("sql.supports")}</span>
        <div className="toolbar-spacer" />
        <button className="btn ghost" disabled={running} onClick={() => void run()}>
          <IconPlay size={13} /> {running ? t("sql.running") : t("sql.run")}
        </button>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
          {dirty ? t("sql.saveChanges") : t("sql.saved")}
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
