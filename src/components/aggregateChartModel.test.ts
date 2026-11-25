import { describe, expect, it } from "vitest";
import type { AggregateColumn, AggregateResult, Json } from "../types";
import {
  BAR_LIMIT,
  PIE_SLICES,
  buildBarSeries,
  buildPieSeries,
  chartColor,
  chartMetrics,
  groupLabel,
  percentText,
} from "./aggregateChartModel";

const GROUP: AggregateColumn = {
  kind: "group",
  column_id: "c1",
  op: null,
  value_type: "text",
  format: null,
};

const COUNT: AggregateColumn = {
  kind: "metric",
  column_id: null,
  op: "count_rows",
  value_type: "number",
  format: null,
};

const AMOUNT: AggregateColumn = {
  kind: "metric",
  column_id: "c2",
  op: "sum",
  value_type: "number",
  format: null,
};

const DATE_MAX: AggregateColumn = {
  kind: "metric",
  column_id: "c3",
  op: "max",
  value_type: "date",
  format: null,
};

function result(
  columns: AggregateColumn[],
  rows: Json[][],
): AggregateResult {
  return {
    columns,
    rows,
    total_groups: rows.length,
    base_rows: rows.length,
  };
}

function row(label: string, value: number | null): Json[] {
  return [label, value];
}

describe("aggregate chart model", () => {
  it("offers only numeric metrics", () => {
    const data = result([GROUP, COUNT, AMOUNT, DATE_MAX], []);
    const metrics = chartMetrics(data, []);
    expect(metrics.map((m) => m.index)).toEqual([1, 2]);
    expect(metrics[0].label).toBe("行数");
  });

  it("joins multiple group fields and formats their values", () => {
    const data = result(
      [GROUP, GROUP, COUNT],
      [
        ["进行中", null, 1],
        ["", "是", 2],
      ],
    );
    expect(groupLabel(data, data.rows[0])).toBe("进行中 · （空值）");
    expect(groupLabel(data, data.rows[1])).toBe("（空文本） · 是");
  });

  it("draws negative bars around a zero baseline", () => {
    const data = result([GROUP, COUNT], [
      row("a", 10),
      row("b", -5),
      row("c", 5),
    ]);
    const series = buildBarSeries(data, chartMetrics(data, [])[0]);
    expect(series.hasNegative).toBe(true);
    expect(series.zero).toBeCloseTo((5 / 15) * 100, 6);
    expect(series.points[0].left).toBeCloseTo(series.zero, 6);
    expect(series.points[0].width).toBeCloseTo((10 / 15) * 100, 6);
    expect(series.points[1].negative).toBe(true);
    expect(series.points[1].left).toBeCloseTo(0, 6);
    expect(series.points[1].width).toBeCloseTo((5 / 15) * 100, 6);
  });

  it("caps bar rows and reports the omitted tail", () => {
    const rows = Array.from({ length: BAR_LIMIT + 7 }, (_, i) => row(`g${i}`, i + 1));
    const data = result([GROUP, COUNT], rows);
    const series = buildBarSeries(data, chartMetrics(data, [])[0]);
    expect(series.shown).toBe(BAR_LIMIT);
    expect(series.total).toBe(BAR_LIMIT + 7);
  });

  it("keeps labels but draws no bars when every value is null", () => {
    const data = result([GROUP, COUNT], [row("a", null), row("b", null)]);
    const series = buildBarSeries(data, chartMetrics(data, [])[0]);
    expect(series.hasData).toBe(false);
    expect(series.points.map((p) => p.display)).toEqual(["—", "—"]);
  });

  it("keeps the largest pie slices and merges the rest into 其他", () => {
    const rows = Array.from({ length: PIE_SLICES + 2 }, (_, i) =>
      row(`g${i + 1}`, i + 1),
    );
    const data = result([GROUP, COUNT], rows);
    const series = buildPieSeries(data, chartMetrics(data, [])[0]);
    expect(series.slices).toHaveLength(PIE_SLICES + 1);
    expect(series.slices[0].label).toBe(`g${PIE_SLICES + 2}`);
    expect(series.merged).toBe(2);
    const other = series.slices[series.slices.length - 1];
    expect(other.isOther).toBe(true);
    expect(other.colorIndex).toBe(-1);
    expect(other.value).toBe(3);
    expect(
      series.slices.reduce((sum, slice) => sum + slice.percent, 0),
    ).toBeCloseTo(100, 6);
  });

  it("skips null, zero and negative values in pies", () => {
    const data = result([GROUP, COUNT], [
      row("a", 5),
      row("b", 0),
      row("c", -3),
      row("d", null),
    ]);
    const series = buildPieSeries(data, chartMetrics(data, [])[0]);
    expect(series.hasData).toBe(true);
    expect(series.slices).toHaveLength(1);
    expect(series.slices[0].percent).toBe(100);
    expect(series.skipped).toBe(3);
  });

  it("formats percentages and resolves CSS chart tokens", () => {
    expect(percentText(50)).toBe("50%");
    expect(percentText(12.34)).toBe("12.3%");
    expect(percentText(0.01)).toBe("<0.1%");
    expect(chartColor(0)).toBe("var(--chart-1)");
    expect(chartColor(7)).toBe("var(--chart-8)");
    expect(chartColor(8)).toBe("var(--chart-1)");
    expect(chartColor(-1)).toBe("var(--chart-other)");
  });
});