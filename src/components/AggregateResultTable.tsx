import type { AggregateResult, ColumnMeta } from "../types";
import { t } from "../i18n";
import {
  aggregateHeaderLabel,
  groupValueText,
  metricValueText,
} from "./aggregateModel";

export default function AggregateResultTable({
  result,
  columns,
}: {
  result: AggregateResult | null;
  columns: ColumnMeta[];
}) {
  if (!result) {
    return (
      <div className="empty-state">
        <div className="empty-card">
          <p>{t("aggregate.loading")}</p>
        </div>
      </div>
    );
  }
  if (result.rows.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-card">
          <p>{t("aggregate.emptyRows")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="sql-scroll aggregate-scroll">
      <table className="sql-table aggregate-table">
        <thead>
          <tr>
            {result.columns.map((col, i) => (
              <th key={i} className={col.kind === "metric" ? "num" : undefined}>
                {aggregateHeaderLabel(col, columns)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => {
                const col = result.columns[ci];
                const text = col
                  ? col.kind === "group"
                    ? groupValueText(col, cell)
                    : metricValueText(col, cell)
                  : String(cell ?? "");
                return (
                  <td
                    key={ci}
                    className={col?.kind === "metric" ? "num" : undefined}
                    title={text}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}