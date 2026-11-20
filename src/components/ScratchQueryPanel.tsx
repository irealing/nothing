// Scratch read-only SQL console: a low-key place to run one SELECT without
// creating a saved view. The statement lives in the store (session only); the
// result is local so it never collides with a SQL view's cached result.

import { useState } from "react";
import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import { SqlEditor } from "./SqlEditor";
import SqlResultTable from "./SqlResultTable";
import { IconCode, IconPlay, IconX } from "./icons";
import { t } from "../i18n";
import type { SqlResult } from "../types";

export default function ScratchQueryPanel() {
  const statement = useWorkspace((s) => s.scratch.statement);
  const setStatement = useWorkspace((s) => s.setScratchStatement);
  const close = useWorkspace((s) => s.closeScratch);

  const [result, setResult] = useState<SqlResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (running || !statement.trim()) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await ipc.runSql(statement, 1000, 0));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="sql-view">
      <div className="toolbar">
        <div className="toolbar-title-group">
          <h2 className="toolbar-title">
            <IconCode size={16} /> {t("sql.scratch")}
          </h2>
          <span className="pill-count">{t("sql.readonly")}</span>
        </div>
        <span className="toolbar-count">{t("sql.scratchHint")}</span>
        <div className="toolbar-spacer" />
        <button
          className="btn ghost"
          disabled={running || !statement.trim()}
          onClick={() => void run()}
        >
          <IconPlay size={13} /> {running ? t("sql.running") : t("sql.run")}
        </button>
        <button
          className="btn-icon"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={close}
        >
          <IconX size={14} />
        </button>
      </div>
      <div className="sql-editor-wrap">
        <SqlEditor
          value={statement}
          onChange={setStatement}
          onRun={() => void run()}
          height="180px"
        />
      </div>
      {error && <div className="form-error sql-error">{error}</div>}
      <div className="sql-result-wrap">
        <SqlResultTable result={result} emptyHint={t("sql.scratchEmpty")} />
      </div>
    </div>
  );
}
