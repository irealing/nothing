import { useMemo } from "react";
import { useWorkspace } from "../stores/workspace";
import type { Json } from "../types";

function renderCell(v: Json): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Read-only renderer for SQL-view results (rich SQL editor arrives in M4). */
export default function SqlResultTable() {
  const sqlResult = useWorkspace((s) => s.sqlResult);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const views = useWorkspace((s) => s.views);
  const view = views.find((v) => v.id === activeViewId);

  const rows = useMemo(() => sqlResult?.rows ?? [], [sqlResult]);

  return (
    <div className="sql-view">
      <div className="toolbar">
        <h2 className="toolbar-title">⌘ {view?.name ?? "SQL 视图"}</h2>
        <span className="toolbar-count">
          {sqlResult ? `${sqlResult.rows.length} 行` : ""}
        </span>
        <div className="toolbar-spacer" />
        <span className="badge-readonly">只读</span>
      </div>
      <div className="sql-scroll">
        {view?.config.kind === "sql" && (
          <pre className="sql-statement">{view.config.statement}</pre>
        )}
        {!sqlResult ? (
          <div className="empty-state">
            <p>没有结果</p>
          </div>
        ) : (
          <table className="sql-table">
            <thead>
              <tr>
                {sqlResult.columns.map((c, i) => (
                  <th key={i}>
                    {c.name}
                    {c.decl_type ? <span className="col-type"> {c.decl_type}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>{renderCell(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
