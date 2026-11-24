// Display formatting. Storage is always ISO8601 UTC (dates) and plain numbers;
// only what the user sees is localized. `ColumnFormat` from `_meta.format`
// refines that (currency, percent, decimals, date style). Copying a cell always
// uses the raw value, never these strings.

import type { ColumnFormat, Currency } from "../types";

export const DISPLAY_LOCALE = "zh-CN";

const dateFmt = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const CURRENCY_CODES: Record<Currency, string> = {
  cny: "CNY",
  usd: "USD",
  eur: "EUR",
  gbp: "GBP",
  jpy: "JPY",
};

/** Format an ISO date for display; invalid/empty values pass through. */
export function formatDate(value: unknown, format?: ColumnFormat | null): string {
  if (value === null || value === undefined || value === "") return "";
  const raw = String(value);
  if (format?.kind === "date") {
    if (format.style === "iso") return raw;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return format.style === "date_time" ? dateTimeFmt.format(date) : dateFmt.format(date);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  // Date-only values (yyyy-mm-dd) are shown without a time component.
  return raw.length <= 10 ? dateFmt.format(date) : dateTimeFmt.format(date);
}

/**
 * Format a stored number for display. Percent follows the stored fraction
 * convention (0.25 → 25%), matching SQLite/formula arithmetic.
 */
export function formatNumber(value: unknown, format?: ColumnFormat | null): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (!format || format.kind !== "number") return String(n);

  const digits = Math.min(6, Math.max(0, Math.round(format.decimals)));
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: format.thousands,
  };
  if (format.style === "currency") {
    options.style = "currency";
    options.currency = CURRENCY_CODES[format.currency ?? "cny"];
  } else if (format.style === "percent") {
    options.style = "percent";
  }
  try {
    return new Intl.NumberFormat(DISPLAY_LOCALE, options).format(n);
  } catch {
    return String(n);
  }
}