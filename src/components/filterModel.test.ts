import { describe, expect, it } from "vitest";
import type { ColumnMeta } from "../types";
import {
  filterRuleCount,
  formatFilterValue,
  normalizeFilterValue,
} from "./filterModel";

const STATUS: ColumnMeta = {
  id: "c2",
  table_id: "t1",
  name: "状态",
  position: 0,
  width: 160,
  icon: null,
  color: null,
  align: null,
  default_value: null,
  created_at: "",
  data: {
    kind: "select",
    sql_name: "c_2",
    choices: [
      { id: "o1", name: "进行中", icon: "🚧", color: "blue", position: 0 },
      { id: "o2", name: "已完成", icon: "✅", color: "green", position: 1 },
    ],
  },
};

describe("normalizeFilterValue", () => {
  it("converts scalars to arrays for in/not_in and back", () => {
    expect(normalizeFilterValue("select", "in", "进行中")).toEqual(["进行中"]);
    expect(normalizeFilterValue("select", "in", "")).toEqual([]);
    expect(normalizeFilterValue("select", "eq", ["进行中", "已完成"])).toBe("进行中");
    expect(normalizeFilterValue("select", "is_empty", "进行中")).toBeNull();
  });

  it("coerces numeric lists and scalars", () => {
    expect(normalizeFilterValue("number", "in", ["1", "2"])).toEqual([1, 2]);
    expect(normalizeFilterValue("number", "eq", "3")).toBe(3);
    expect(normalizeFilterValue("number", "eq", ["4"])).toBe(4);
  });
});

describe("formatFilterValue", () => {
  it("resolves option icons and joins list values", () => {
    expect(
      formatFilterValue(STATUS, {
        column_id: STATUS.id,
        op: "in",
        value: ["进行中", "已完成"],
      }),
    ).toBe("🚧 进行中、✅ 已完成");
  });

  it("shows an empty marker for a blank configured value", () => {
    expect(formatFilterValue(STATUS, { column_id: STATUS.id, op: "eq", value: "" })).toBe(
      "（空）",
    );
  });
});

describe("filterRuleCount", () => {
  it("counts rules inside nested groups", () => {
    expect(
      filterRuleCount({
        op: "and",
        children: [
          { column_id: "c1", op: "eq", value: "a" },
          {
            op: "or",
            children: [
              { column_id: "c2", op: "eq", value: "b" },
              { column_id: "c3", op: "eq", value: "c" },
            ],
          },
        ],
      }),
    ).toBe(3);
    expect(filterRuleCount(null)).toBe(0);
  });
});