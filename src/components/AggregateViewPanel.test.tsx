// @vitest-environment jsdom
//
// View mode is presentation state: switching to a chart must not write the
// view, and the table must come back unchanged.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  AggregateColumn,
  AggregateResult,
  ColumnMeta,
  ViewMeta,
} from "../types";
import { useWorkspace } from "../stores/workspace";
import AggregateViewPanel from "./AggregateViewPanel";

const STATUS: ColumnMeta = {
  id: "c1",
  table_id: "t1",
  name: "状态",
  position: 0,
  width: 160,
  icon: null,
  color: null,
  align: null,
  default_value: null,
  format: null,
  created_at: "",
  data: { kind: "select", sql_name: "c_1", choices: [] },
};

const GROUP: AggregateColumn = {
  kind: "group",
  column_id: STATUS.id,
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

const RESULT: AggregateResult = {
  columns: [GROUP, COUNT],
  rows: [
    ["进行中", 3],
    ["已完成", 5],
  ],
  total_groups: 2,
  base_rows: 8,
};

const VIEW: ViewMeta = {
  id: "va",
  table_id: "t1",
  name: "按状态汇总",
  kind: "grid",
  icon: null,
  color: null,
  position: 0,
  created_at: "",
  data: {
    kind: "grid",
    filters: null,
    sorts: [],
    aggregate: {
      group_by: [STATUS.id],
      metrics: [{ op: "count_rows", column_id: null }],
      sort: null,
    },
  },
  columns: [],
};

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  useWorkspace.setState({
    columns: [STATUS],
    aggregateResult: RESULT,
    error: null,
  });
});

afterEach(cleanup);

describe("AggregateViewPanel view modes", () => {
  it("switches table, bar and pie without changing the view", async () => {
    const user = userEvent.setup();
    render(<AggregateViewPanel view={VIEW} />);

    expect(screen.getByRole("table")).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "柱状图" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelectorAll(".bar-row")).toHaveLength(2);
    expect(screen.getByText("进行中")).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "饼图" }));
    expect(document.querySelectorAll(".pie-legend li")).toHaveLength(2);
    expect(screen.getByText("合计")).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "表格" }));
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("asks for a group field before drawing a chart", async () => {
    useWorkspace.setState({
      aggregateResult: {
        columns: [COUNT],
        rows: [[8]],
        total_groups: 1,
        base_rows: 8,
      },
    });
    const user = userEvent.setup();
    render(<AggregateViewPanel view={VIEW} />);

    await user.click(screen.getByRole("radio", { name: "柱状图" }));
    expect(screen.getByText(/至少一个分组字段/)).toBeTruthy();
  });
});