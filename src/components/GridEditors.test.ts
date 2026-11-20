// Unit tests for the floating cell editor's value normalization: text, number
// and date round-trips, plus the "invalid number" rejection path.

import { describe, expect, it } from "vitest";
import type { ColumnMeta, ColumnType } from "../types";
import { textForEditor, valueFromEditor } from "./GridEditors";

function col(type: ColumnType): ColumnMeta {
  return {
    id: "c1",
    table_id: "t1",
    name: type,
    sql_name: "c_x",
    type,
    opts: { kind: "plain" },
    position: 0,
    width: 160,
    visible: true,
    is_reverse: false,
    reverse_of: null,
    icon: null,
    color: null,
    created_at: "",
  };
}

describe("textForEditor", () => {
  it("renders empty for null/undefined", () => {
    expect(textForEditor(col("text"), null)).toBe("");
    expect(textForEditor(col("number"), null)).toBe("");
  });

  it("passes text through verbatim", () => {
    expect(textForEditor(col("text"), "你好 world")).toBe("你好 world");
  });

  it("renders numbers and booleans as strings", () => {
    expect(textForEditor(col("number"), 12.5)).toBe("12.5");
    expect(textForEditor(col("date"), true)).toBe("true");
  });

  it("trims ISO8601 datetimes down to the date part", () => {
    expect(textForEditor(col("date"), "2026-11-20T09:30:00Z")).toBe("2026-11-20");
    expect(textForEditor(col("date"), "2026-11-20")).toBe("2026-11-20");
  });
});

describe("valueFromEditor", () => {
  it("clears text cells when emptied", () => {
    expect(valueFromEditor(col("text"), "")).toBeNull();
    expect(valueFromEditor(col("text"), "abc")).toBe("abc");
  });

  it("parses numbers and treats blank as null", () => {
    expect(valueFromEditor(col("number"), "42")).toBe(42);
    expect(valueFromEditor(col("number"), " -3.5 ")).toBe(-3.5);
    expect(valueFromEditor(col("number"), "")).toBeNull();
  });

  it("rejects invalid numbers instead of committing NaN", () => {
    expect(valueFromEditor(col("number"), "12abc")).toBeUndefined();
    expect(valueFromEditor(col("number"), "--")).toBeUndefined();
  });

  it("keeps dates as plain ISO date strings", () => {
    expect(valueFromEditor(col("date"), "2026-12-01")).toBe("2026-12-01");
    expect(valueFromEditor(col("date"), "")).toBeNull();
  });
});