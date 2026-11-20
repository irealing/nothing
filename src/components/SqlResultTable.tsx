import type { Json, SqlResult } from "../types";

function renderCell(v: Json): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Pure renderer for columnar SQL results. */
export default function SqlResultTable({ result }: { result: SqlResult | null }) {
  if (!result) {
    return (
      <div className="empty-state">
        <p>点「▶ 运行」查看结果；保存后打开视图会自动执行</p>
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
      <div className="sql-rowcount">{result.rows.length} 行</div>
    </div>
  );
}
