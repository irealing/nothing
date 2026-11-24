// @vitest-environment jsdom
//
// The schema browser is the only way to discover physical table/column names
// from the UI, so these tests pin the grouping rules and the click-to-query
// behaviour that the scratch console depends on.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../ipc", () => ({ tableList: vi.fn(), columnList: vi.fn() }));

import * as ipc from "../ipc";
import type { ColumnData, ColumnMeta, ColumnType, TableMeta } from "../types";
import { useWorkspace } from "../stores/workspace";
import { groupSchema, SchemaBrowser, tableQuery } from "./SchemaBrowser";

const T1: TableMeta = {
  id: "t1",
  name: "任务",
  sql_name: "t_01h1",
  title_col_id: "c1",
  icon: "📋",
  color: null,
  position: 0,
  created_at: "",
  updated_at: "",
};

const T2: TableMeta = {
  id: "t2",
  name: "项目",
  sql_name: "t_01h2",
  title_col_id: "c4",
  icon: null,
  color: null,
  position: 1,
  created_at: "",
  updated_at: "",
};

function dataFor(id: string, type: ColumnType): ColumnData {
  const sql_name = `c_${id}`;
  switch (type) {
    case "relation":
      return { kind: "relation", target_table_id: "t2", single: false, origin_id: null };
    case "formula":
      return { kind: "formula", sql_name, expr: "1", result_type: "number" };
    case "number":
      return { kind: "number", sql_name };
    case "date":
      return { kind: "date", sql_name };
    case "checkbox":
      return { kind: "checkbox", sql_name };
    case "select":
      return { kind: "select", sql_name, choices: [] };
    case "multi_select":
      return { kind: "multi_select", sql_name, choices: [] };
    default:
      return { kind: "text", sql_name };
  }
}

function col(
  id: string,
  table_id: string,
  name: string,
  type: ColumnType,
  position: number,
  extra: Partial<ColumnMeta> = {},
): ColumnMeta {
  return {
    id,
    table_id,
    name,
    position,
    width: 160,
    icon: null,
    color: null,
    align: null,
    default_value: null,
    created_at: "",
    data: dataFor(id, type),
    ...extra,
    format: extra.format ?? null,
  };
}

const C_TITLE = col("c1", "t1", "标题", "text", 0);
const C_REL = col("c2", "t1", "关联任务", "relation", 1);
const C_REVERSE: ColumnMeta = {
  ...col("c3", "t1", "反向", "relation", 2),
  data: { kind: "relation", target_table_id: "t2", single: false, origin_id: "c2" },
};
const C_FORMULA = col("c4", "t1", "得分", "formula", 3);
const C_T2 = col("c5", "t2", "名称", "text", 0);

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspace.setState({ dataVersion: 1, activeTableId: "t1" });
  vi.mocked(ipc.tableList).mockResolvedValue([T2, T1]);
  vi.mocked(ipc.columnList).mockImplementation(async (tableId: string) =>
    tableId === "t1" ? [C_TITLE, C_REL, C_REVERSE, C_FORMULA] : [C_T2],
  );
});

afterEach(() => cleanup());

describe("groupSchema", () => {
  it("sorts tables and columns and drops reverse relation columns", () => {
    const groups = groupSchema(
      [T2, T1],
      new Map([
        ["t1", [C_FORMULA, C_REL, C_REVERSE, C_TITLE]],
        ["t2", []],
      ]),
    );

    expect(groups.map((g) => g.table.id)).toEqual(["t1", "t2"]);
    expect(groups[0].physical.map((c) => c.id)).toEqual(["c1", "c4"]);
    expect(groups[0].relations.map((c) => c.id)).toEqual(["c2"]);
  });

  it("builds a quoted, limited table query", () => {
    expect(tableQuery("t_01h1")).toBe('SELECT * FROM "t_01h1" LIMIT 100');
    expect(tableQuery('a"b')).toBe('SELECT * FROM "a""b" LIMIT 100');
  });
});

describe("SchemaBrowser", () => {
  it("lists tables and emits the physical name when one is clicked", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SchemaBrowser onPickTable={onPick} />);

    await user.click(screen.getByRole("button", { name: /表结构/ }));

    // The active table is expanded by default: physical columns + relation.
    expect(await screen.findByText("c_c1")).toBeTruthy();
    expect(screen.getByText("r_c2")).toBeTruthy();
    expect(screen.queryByText("c_c3")).toBeNull(); // reverse column dropped

    await user.click(screen.getByText("t_01h1"));
    expect(onPick).toHaveBeenCalledWith("t_01h1");
  });

  it("expands another table on demand", async () => {
    const user = userEvent.setup();
    render(<SchemaBrowser onPickTable={() => {}} />);

    await user.click(screen.getByRole("button", { name: /表结构/ }));
    await screen.findByText("t_01h2");
    expect(screen.queryByText("c_c5")).toBeNull();

    const toggles = screen.getAllByRole("button", { name: "展开或收起列" });
    await user.click(toggles[1]);
    expect(await screen.findByText("c_c5")).toBeTruthy();
  });
});