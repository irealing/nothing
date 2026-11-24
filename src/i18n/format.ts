// Display formatting. Storage is always ISO8601 UTC (dates) and plain numbers;
// only what the user sees is localized.

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

/** Format an ISO date for display; invalid/empty values pass through. */
export function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const raw = String(value);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  // Date-only values (yyyy-mm-dd) are shown without a time component.
  return raw.length <= 10 ? dateFmt.format(date) : dateTimeFmt.format(date);
}