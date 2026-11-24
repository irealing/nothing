import { describe, expect, it } from "vitest";
import { formatDate, formatNumber } from "./format";

describe("formatNumber", () => {
  it("passes empty values through", () => {
    expect(formatNumber(null)).toBe("");
    expect(formatNumber(undefined)).toBe("");
    expect(formatNumber("")).toBe("");
  });

  it("renders plain numbers without a format", () => {
    expect(formatNumber(12.5)).toBe("12.5");
    expect(formatNumber("3.25")).toBe("3.25");
  });

  it("applies decimals and grouping", () => {
    const text = formatNumber(1234.5, {
      kind: "number",
      style: "plain",
      currency: null,
      decimals: 2,
      thousands: true,
    });
    expect(text).toContain("1,234.50");
    const bare = formatNumber(1234.5, {
      kind: "number",
      style: "plain",
      currency: null,
      decimals: 0,
      thousands: false,
    });
    expect(bare).toBe("1235");
  });

  it("renders percent from the stored fraction", () => {
    const text = formatNumber(0.25, {
      kind: "number",
      style: "percent",
      currency: null,
      decimals: 0,
      thousands: false,
    });
    expect(text).toContain("25");
    expect(text).toContain("%");
  });

  it("renders the requested currency", () => {
    const text = formatNumber(12, {
      kind: "number",
      style: "currency",
      currency: "usd",
      decimals: 2,
      thousands: true,
    });
    expect(text).toContain("12.00");
    expect(text).toMatch(/[$]|USD/);
  });

  it("leaves non-numeric values untouched", () => {
    expect(formatNumber("abc")).toBe("abc");
  });
});

describe("formatDate", () => {
  it("returns the raw ISO string when asked", () => {
    expect(
      formatDate("2024-05-06T07:08:09Z", { kind: "date", style: "iso" }),
    ).toBe("2024-05-06T07:08:09Z");
  });

  it("formats a date without a time component", () => {
    const text = formatDate("2024-05-06", { kind: "date", style: "date" });
    expect(text).toContain("2024");
    expect(text).not.toContain(":");
  });

  it("formats a date with a time component", () => {
    const text = formatDate("2024-05-06T07:08:09Z", {
      kind: "date",
      style: "date_time",
    });
    expect(text).toContain("2024");
    expect(text).toContain(":");
  });

  it("falls back to the value when it cannot be parsed", () => {
    expect(formatDate("not-a-date", { kind: "date", style: "date" })).toBe(
      "not-a-date",
    );
  });
});