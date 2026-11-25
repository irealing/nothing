import type { AggregateColumn, AggregateResult, ColumnMeta, Json } from "../types";
import { formatDate, formatNumber } from "../i18n/format";
import { t } from "../i18n";
import { metricOpLabel } from "./aggregateModel";

function sourceColumn(col: AggregateColumn, columns: ColumnMeta[]): ColumnMeta | undefined {
  return col.column_id ? columns.find((c) => c.id === col.column_id) : undefined;
}

function headerLabel(col: AggregateColumn, columns: ColumnMeta[]): string {
  const source = sourceColumn(col, columns);
  if (col.kind === "group") return source?.name ?? t("aggregate.unknownColumn");
  if (!col.op || col.op === "count_rows") return t("aggregate.ops.count_rows");
  const opLabel = metricOpLabel(col.op, source);
  return source ? `${source.name} · ${opLabel}` : opLabel;
}

function groupCell(col: AggregateColumn, value: Json): string {
  if (value === null || value === undefined) return t("aggregate.emptyValue");
  if (col.value_type === "checkbox") {
    return value === true || value === 1 ? t("aggregate.checked") : t("aggregate.unchecked");
  }
  if (col.value_type === "date") return formatDate(value, col.format);
  if (col.value_type === "number") return formatNumber(value, col.format);
  const text = String(value);
  return text === "" ? t("aggregate.emptyText") : text;
}

function metricCell(col: AggregateColumn, value: Json): string {
  if (value === null || value === undefined) return t("aggregate.noValue");
  if (col.value_type === "date") return formatDate(value, col.format);
  if (col.value_type === "number") return formatNumber(value, col.format);
  const text = String(value);
  return text === "" ? t("aggregate.noValue") : text;
}

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
                {headerLabel(col, columns)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => {
                const col = result.columns[ci];
                return (
                  <td key={ci} className={col?.kind === "metric" ? "num" : undefined}>
                    {col
                      ? col.kind === "group"
                        ? groupCell(col, cell)
                        : metricCell(col, cell)
                      : String(cell ?? "")}
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