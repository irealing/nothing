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

/** Vivid-first order used when a new option gets an automatic color. */
export const AUTO_TAG_COLORS: ColumnColor[] = [
  "blue",
  "purple",
  "green",
  "orange",
  "pink",
  "yellow",
  "red",
  "brown",
  "gray",
];

/**
 * First palette color not already used by an existing option. Falls back to
 * cycling once all nine are taken, so adding an option always yields a color.
 */
export function pickAutoColor(
  used: readonly (string | null | undefined)[],
): ColumnColor {
  const taken = new Set(used.filter((c): c is string => typeof c === "string" && c !== ""));
  return (
    AUTO_TAG_COLORS.find((c) => !taken.has(c)) ??
    AUTO_TAG_COLORS[used.length % AUTO_TAG_COLORS.length]
  );
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface ChipColors {
  background: string;
  color: string;
  /** One hairline in the hue's border step. */
  borderColor: string;
}

export type ChipPalette = Record<ColumnColor, ChipColors>;

export interface OptionPalette {
  byColor: ChipPalette;
  /** Fallback for values whose option no longer exists (renamed/deleted). */
  neutral: ChipColors;
}

/**
 * Resolve the option-chip palette once per theme. Canvas drawing cannot read
 * CSS variables, so the custom cell renderer needs plain values up front.
 */
export function readOptionPalette(): OptionPalette {
  const byColor = Object.fromEntries(
    TAG_COLORS.map((color) => [
      color,
      {
        background: cssVar(`--chip-${color}-bg`),
        color: cssVar(`--chip-${color}-fg`),
        borderColor: cssVar(`--chip-${color}-border`),
      } satisfies ChipColors,
    ]),
  ) as ChipPalette;
  return {
    byColor,
    neutral: {
      background: cssVar("--bg-hover"),
      color: cssVar("--text-mid"),
      borderColor: cssVar("--border-strong"),
    },
  };
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

/** Inline style for a palette chip in regular DOM (dialogs, menus, filters). */
export function chipStyle(
  color: ColumnColor,
): { background: string; color: string; border: string } {
  return {
    background: cssVar(`--chip-${color}-bg`),
    color: cssVar(`--chip-${color}-fg`),
    border: `1px solid ${cssVar(`--chip-${color}-border`)}`,
  };
}

/** Solid, vivid dot for the palette picker. */
export function swatchStyle(color: ColumnColor): { background: string; color: string } {
  return {
    background: cssVar(`--swatch-${color}-bg`),
    color: cssVar(`--swatch-${color}-fg`),
  };
}

/** Grid header tint matching a palette column. */
export function headerStyle(color: ColumnColor): { background: string; color: string } {
  return {
    background: cssVar(`--tag-${color}-header-bg`),
    color: cssVar(`--tag-${color}-header-fg`),
  };
}

/** Cell background matching a palette column (used by the header preview). */
export function cellStyle(color: ColumnColor): { background: string } {
  return { background: cssVar(`--tag-${color}-cell-bg`) };
}
