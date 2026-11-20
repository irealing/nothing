// Typed i18n core. Only Chinese ships today; the indirection exists so a new
// locale is a drop-in file plus one registry line, and so every key is
// compile-time checked.

import { zh, type Messages } from "./zh";

export type Dict = Messages;

/** Shape of any additional locale: identical leaves, so nothing can be missed. */
export type Translation = Dict;

const LOCALES: Record<string, Dict> = { zh };
let currentLocale = "zh";

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<Dict>;

function lookup(dict: Dict, path: string): string | undefined {
  let node: unknown = dict;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const raw = lookup(LOCALES[currentLocale], key) ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] === undefined ? `{${name}}` : String(params[name]),
  );
}

export function setLocale(locale: string): void {
  if (LOCALES[locale]) currentLocale = locale;
}

export function getLocale(): string {
  return currentLocale;
}

/**
 * User-facing text for any thrown value. Backend `AppError` kinds map to a
 * localized sentence; the original message is appended for the kinds where the
 * detail carries information (which name, which table…).
 */
export function errorText(e: unknown): string {
  const kind = typeof e === "object" && e !== null && "kind" in e ? String((e as { kind: unknown }).kind) : "Unknown";
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const known = lookup(LOCALES[currentLocale], `errors.${kind}`);
  if (!known) return message || t("errors.Unknown");
  const detailed = kind === "NotFound" || kind === "AlreadyExists" || kind === "InvalidInput" || kind === "Rejected";
  return detailed && message ? `${known}：${message}` : known;
}