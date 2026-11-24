import { describe, expect, it } from "vitest";
import type { ColumnMeta } from "../types";
import {
  PILL_DOT_GAP,
  PILL_DOT_SIZE,
  PILL_PADDING_X,
  layoutOptionPills,
  optionCellFor,
  pillLabel,
  type OptionPill,
} from "./OptionCell";

const measure = (text: string) => text.length * 7;

function pill(
  name: string,
  color: OptionPill["color"] = null,
  icon: string | null = null,
): OptionPill {
  return { name, color, icon };
}

describe("layoutOptionPills", () => {
  it("keeps every pill when the row fits", () => {
    const pills = [pill("待办"), pill("进行中"), pill("完成")];
    const layout = layoutOptionPills(pills, 500, measure);
    expect(layout.hidden).toBe(0);
    expect(layout.counterLabel).toBeNull();
    expect(layout.visible.map((v) => v.label)).toEqual(["待办", "进行中", "完成"]);
  });

  it("reserves room for a +N counter when the row overflows", () => {
    const pills = [pill("待办"), pill("进行中"), pill("完成")];
    // Each label is 21px wide + 16px padding + 11px dot space = 48px.
    const layout = layoutOptionPills(pills, 100, measure);
    expect(layout.visible).toHaveLength(1);
    expect(layout.hidden).toBe(2);
    expect(layout.counterLabel).toBe("+2");
    expect(layout.counterWidth).toBeGreaterThan(0);
  });

  it("reserves dot space only when the option has no icon", () => {
    const plain = layoutOptionPills([pill("待办")], 500, measure).visible[0];
    expect(plain.width).toBe(
      measure("待办") + PILL_PADDING_X * 2 + PILL_DOT_SIZE + PILL_DOT_GAP,
    );

    const withIcon = layoutOptionPills([pill("待办", null, "✅")], 500, measure).visible[0];
    expect(withIcon.width).toBe(measure("✅ 待办") + PILL_PADDING_X * 2);
  });

  it("keeps a truncated first pill instead of showing only a counter", () => {
    const layout = layoutOptionPills([pill("一个很长的选项")], 24, measure);
    expect(layout.visible).toHaveLength(1);
    expect(layout.visible[0].width).toBe(24);
    expect(layout.hidden).toBe(0);
    expect(layout.counterLabel).toBeNull();
  });

  it("returns an empty layout for an empty value", () => {
    expect(layoutOptionPills([], 100, measure)).toEqual({
      visible: [],
      hidden: 0,
      counterLabel: null,
      counterWidth: 0,
    });
  });
});

describe("optionCellFor", () => {
  const col: ColumnMeta = {
    id: "c1",
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
      sql_name: "c_status",
      choices: [
        { id: "a", name: "待办", icon: "📝", color: "blue", position: 0 },
        { id: "b", name: "完成", icon: null, color: "green", position: 1 },
      ],
    },
  };

  it("carries option icon and color into the cell payload", () => {
    const cell = optionCellFor(col, "待办");
    expect(cell.kind).toBe("custom");
    expect(cell.data.pills).toEqual([{ name: "待办", icon: "📝", color: "blue" }]);
    expect(cell.copyData).toBe("待办");
  });

  it("keeps legacy values that no longer match an option", () => {
    const cell = optionCellFor(col, ["完成", "已删除"]);
    expect(cell.data.pills).toEqual([
      { name: "完成", icon: null, color: "green" },
      { name: "已删除", icon: null, color: null },
    ]);
    expect(cell.copyData).toBe("完成, 已删除");
  });
});

describe("pillLabel", () => {
  it("prefixes the icon with one space", () => {
    expect(pillLabel(pill("待办", "blue", "📝"))).toBe("📝 待办");
    expect(pillLabel(pill("待办"))).toBe("待办");
  });
});