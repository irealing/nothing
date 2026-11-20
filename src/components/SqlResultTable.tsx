import type { Json, SqlResult } from "../types";
import { IconCode } from "./icons";
import { t } from "../i18n";

function renderCell(v: Json): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Pure renderer for columnar SQL results. */
export default function SqlResultTable({
  result,
  emptyHint,
}: {
  result: SqlResult | null;
  /** Overrides the SQL-view hint for callers without a save action. */
  emptyHint?: string;
}) {
  if (!result) {
    return (
      <div className="empty-state">
        <div className="empty-card">
          <span className="empty-icon">
            <IconCode size={24} />
          </span>
          <p>{emptyHint ?? t("sql.emptyHint")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="sql-scroll">
      <table className="sql-table">
        <thead>
          <tr>
            {result.columns.map((c, i) => (
              <th key={i}>
                {c.name}
                {c.decl_type ? <span className="col-type"> {c.decl_type}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{renderCell(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sql-rowcount">{t("sql.rows", { count: result.rows.length })}</div>
    </div>
  );
}
