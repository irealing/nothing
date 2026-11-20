// Bridge between the CSS design tokens and Glide Data Grid's `Theme` object.
//
// Glide renders to canvas and never reads CSS variables, so every token it
// needs is resolved here. The result is memoized per resolved theme in the
// components that use it (see TableView).

import { getDefaultTheme, type Theme } from "@glideapps/glide-data-grid";
import type { ColumnColor } from "../types";

export const TAG_COLORS: ColumnColor[] = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
  "brown",
];

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Read the current theme tokens into a Glide theme. */
export function readGridTheme(): Theme {
  const base = getDefaultTheme();
  const text = cssVar("--text");
  const accent = cssVar("--accent");
  return {
    ...base,
    accentColor: accent,
    accentFg: cssVar("--accent-fg"),
    accentLight: cssVar("--accent-weak"),
    textDark: text,
    textMedium: cssVar("--text-mid"),
    textLight: cssVar("--text-weak"),
    textBubble: text,
    textHeader: cssVar("--text-mid"),
    textHeaderSelected: cssVar("--text"),
    bgIconHeader: cssVar("--text-weak"),
    fgIconHeader: cssVar("--bg"),
    bgCell: cssVar("--bg"),
    bgCellMedium: cssVar("--bg-hover"),
    bgHeader: cssVar("--bg-side"),
    bgHeaderHovered: cssVar("--bg-active"),
    bgHeaderHasFocus: cssVar("--bg-active"),
    bgBubble: cssVar("--bg-hover"),
    bgBubbleSelected: cssVar("--accent-weak"),
    bgSearchResult: cssVar("--search-highlight"),
    borderColor: cssVar("--border"),
    drilldownBorder: cssVar("--border-strong"),
    linkColor: accent,
    fontFamily: cssVar("--font"),
    headerFontStyle: "600 13px",
    baseFontStyle: "13px",
    markerFontStyle: "500 12px",
    headerIconSize: 16,
  };
}

/**
 * Per-column theme override for a palette color.
 *
 * Header and cells are tinted, but text color is left to the base theme (the
 * palette only changes backgrounds). Hover variants are explicit 鈥?without
 * them Glide falls back to the global surface and flashes on hover.
 */
export function tagThemeOverride(color: ColumnColor): Partial<Theme> {
  return {
    bgHeader: cssVar(`--tag-${color}-header-bg`),
    bgHeaderHovered: cssVar(`--tag-${color}-header-bg`),
    bgHeaderHasFocus: cssVar(`--tag-${color}-header-bg`),
    textHeader: cssVar(`--tag-${color}-header-fg`),
    bgCell: cssVar(`--tag-${color}-cell-bg`),
    bgCellMedium: cssVar(`--tag-${color}-cell-bg-hover`),
  };
}

/** Inline style for a palette chip in regular DOM (dialogs, menus). */
export function tagChipStyle(color: ColumnColor): { background: string; color: string } {
  return {
    background: cssVar(`--tag-${color}-header-bg`),
    color: cssVar(`--tag-${color}-header-fg`),
  };
}

/** Cell background matching a palette column (used by the header preview). */
export function tagCellStyle(color: ColumnColor): { background: string } {
  return { background: cssVar(`--tag-${color}-cell-bg`) };
}
