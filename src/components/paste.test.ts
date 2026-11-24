// Unit tests for TSV paste coercion: each column type either yields a value
// the backend accepts, or `undefined` so the caller can skip and count it.

import { describe, expect, it } from "vitest";
import type { Choice, ColumnMeta, ColumnType } from "../types";
import { parsePasteValue } from "./TableView";

function col(type: ColumnType, choices: Choice[] = []): ColumnMeta {
  const sql_name = "c_x";
  const data =
    type === "select"
      ? ({ kind: "select", sql_name, choices } as const)
      : type === "multi_select"
        ? ({ kind: "multi_select", sql_name, choices } as const)
        : type === "number"
        ? ({ kind: "number", sql_name } as const)
        : type === "date"
          ? ({ kind: "date", sql_name } as const)
          : type === "checkbox"
            ? ({ kind: "checkbox", sql_name } as const)
            : type === "formula"
              ? ({ kind: "formula", sql_name, expr: "[x]", result_type: "text" } as const)
              : ({ kind: "text", sql_name } as const);
  return {
    id: "c1",
    table_id: "t1",
    name: type,
    position: 0,
    width: 160,
    icon: null,
    color: null,
    align: null,
    default_value: null,
    created_at: "",
    data,
  };
}

const CHOICES: Choice[] = [
  { id: "o1", name: "Todo", icon: null, color: "blue", position: 0 },
  { id: "o2", name: "Done", icon: null, color: "green", position: 1 },
];

describe("parsePasteValue", () => {
  it("parses numbers and rejects non-numeric text", () => {
    expect(parsePasteValue(col("number"), " 42 ")).toBe(42);
    expect(parsePasteValue(col("number"), "-3.5")).toBe(-3.5);
    expect(parsePasteValue(col("number"), "")).toBeNull();
    expect(parsePasteValue(col("number"), "12abc")).toBeUndefined();
  });

  it("maps checkbox spellings, empty means false", () => {
    expect(parsePasteValue(col("checkbox"), "TRUE")).toBe(true);
    expect(parsePasteValue(col("checkbox"), "是")).toBe(true);
    expect(parsePasteValue(col("checkbox"), "0")).toBe(false);
    expect(parsePasteValue(col("checkbox"), "")).toBe(false);
    expect(parsePasteValue(col("checkbox"), "maybe")).toBeUndefined();
  });

  it("normalizes common date shapes to ISO", () => {
    expect(parsePasteValue(col("date"), "2026-1-2")).toBe("2026-01-02");
    expect(parsePasteValue(col("date"), "2026/01/02")).toBe("2026-01-02");
    expect(parsePasteValue(col("date"), "1/2/2026")).toBe("2026-01-02");
    expect(parsePasteValue(col("date"), "jan 2")).toBeUndefined();
  });

  it("matches select option names case-insensitively", () => {
    expect(parsePasteValue(col("select", CHOICES), "Todo")).toBe("Todo");
    expect(parsePasteValue(col("select", CHOICES), "done")).toBe("Done");
    expect(parsePasteValue(col("select", CHOICES), "Blocked")).toBeUndefined();
  });

  it("rejects a multi-select cell when any label is unknown", () => {
    expect(parsePasteValue(col("multi_select", CHOICES), "Todo，Done")).toEqual(["Todo", "Done"]);
    expect(parsePasteValue(col("multi_select", CHOICES), "Todo; Nope")).toBeUndefined();
  });

  it("never writes formulas or relations", () => {
    expect(parsePasteValue(col("formula"), "1")).toBeUndefined();
  });

  it("keeps text verbatim and empties as null", () => {
    expect(parsePasteValue(col("text"), " a b ")).toBe(" a b ");
    expect(parsePasteValue(col("text"), "")).toBeNull();
  });
});