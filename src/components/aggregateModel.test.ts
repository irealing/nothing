import { describe, expect, it } from "vitest";
import type { AggregateConfig, ColumnMeta, ColumnType } from "../types";
import {
  columnsForOp,
  defaultAggregateConfig,
  groupableColumns,
  metricOpsForColumn,
  nextMetric,
  normalizeMetric,
  validateAggregateConfig,
} from "./aggregateModel";

function col(id: string, type: ColumnType, name = id): ColumnMeta {
  const data = (() => {
    switch (type) {
      case "relation":
        return {
          kind: "relation" as const,
          target_table_id: "t2",
          single: false,
          origin_id: null,
        };
      case "formula":
        return {
          kind: "formula" as const,
          sql_name: `c_${id}`,
          expr: "1",
          result_type: "number" as const,
        };
      case "select":
      case "multi_select":
        return { kind: type, sql_name: `c_${id}`, choices: [] };
      default:
        return { kind: type, sql_name: `c_${id}` };
    }
  })();
  return {
    id,
    table_id: "t1",
    name,
    position: 0,
    width: 160,
    icon: null,
    color: null,
    align: null,
    default_value: null,
    format: null,
    created_at: "",
    data,
  };
}

const cols = [
  col("title", "text"),
  col("hours", "number"),
  col("status", "select"),
  col("done", "checkbox"),
  col("due", "date"),
  col("calc", "formula"),
  col("tags", "multi_select"),
  col("rel", "relation"),
];

describe("aggregate model", () => {
  it("only groups scalar columns and groups formula results by their type", () => {
    const ids = groupableColumns(cols).map((c) => c.id);
    expect(ids).toEqual(["title", "hours", "status", "done", "due", "calc"]);
  });

  it("offers metrics by effective column type", () => {
    expect(metricOpsForColumn(col("hours", "number"))).toContain("sum");
    expect(metricOpsForColumn(col("done", "checkbox"))).toContain("sum");
    expect(metricOpsForColumn(col("due", "date"))).toEqual([
      "count_non_empty",
      "count_distinct",
      "min",
      "max",
    ]);
    expect(metricOpsForColumn(col("title", "text"))).not.toContain("sum");
    expect(metricOpsForColumn(col("rel", "relation"))).toEqual([]);
  });

  it("chooses a free metric and normalizes operators", () => {
    const start = defaultAggregateConfig();
    const second = nextMetric(start.metrics, cols);
    expect(second).toEqual({ op: "count_non_empty", column_id: "title" });
    expect(nextMetric([...start.metrics, second!], cols)).not.toEqual(second);
    expect(normalizeMetric("count_rows", cols)).toEqual({
      op: "count_rows",
      column_id: null,
    });
    expect(columnsForOp("sum", cols).map((c) => c.id)).toEqual(["hours", "done", "calc"]);
  });

  it("validates duplicate groups, missing metrics and type mismatches", () => {
    const base: AggregateConfig = {
      group_by: [],
      metrics: [{ op: "count_rows", column_id: null }],
      sort: null,
    };
    expect(validateAggregateConfig(base, cols)).toBeNull();
    expect(
      validateAggregateConfig({ ...base, metrics: [] }, cols),
    ).toContain("指标");
    expect(
      validateAggregateConfig(
        { ...base, group_by: ["status", "status"] },
        cols,
      ),
    ).toContain("重复");
    expect(
      validateAggregateConfig(
        {
          ...base,
          metrics: [{ op: "sum", column_id: "title" }],
        },
        cols,
      ),
    ).toContain("不匹配");
    expect(
      validateAggregateConfig(
        { ...base, group_by: ["rel"] },
        cols,
      ),
    ).toContain("不支持");
  });
});