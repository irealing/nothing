// Bridge between the CSS design tokens and Glide Data Grid's `Theme` object.
//
// Glide renders to canvas and never reads CSS variables, so every token it
// needs is resolved here. The result is memoized per resolved theme in the
// components that use it (see TableView).

import { getDefaultTheme, type Theme } from "@glideapps/glide-data-grid";
import type { ColumnColor, PresetColor } from "../types";
import { customScale, type CustomScale } from "./color";

/** Curated palette, in picker order. Mirrors `COLUMN_COLOR_TOKENS` in Rust. */
export const TAG_COLORS: PresetColor[] = [
  "gray",
  "brown",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "plum",
  "pink",
  "crimson",
  "red",
];

/** Vivid-first order used when a new option gets an automatic color. */
export const AUTO_TAG_COLORS: PresetColor[] = [
  "blue",
  "purple",
  "green",
  "orange",
  "pink",
  "yellow",
  "red",
  "brown",
  "gray",
  "teal",
  "indigo",
  "lime",
  "amber",
  "plum",
  "sky",
  "crimson",
  "violet",
  "cyan",
];

export function isPresetColor(color: string): color is PresetColor {
  return (TAG_COLORS as readonly string[]).includes(color);
}

/**
 * First preset color not already used by an existing option. Custom colors are
 * ignored (they are not part of the cycle). Falls back to cycling once every
 * preset is taken, so adding an option always yields a color.
 */
export function pickAutoColor(
  used: readonly (string | null | undefined)[],
): PresetColor {
  const taken = new Set(used.filter((c): c is PresetColor => !!c && isPresetColor(c)));
  const free = AUTO_TAG_COLORS.find((c) => !taken.has(c));
  if (free) return free;
  // Everything is taken: cycle by how many preset assignments exist, not by
  // array length, so custom colors do not shift the sequence.
  const presetCount = used.filter((c) => !!c && isPresetColor(c)).length;
  return AUTO_TAG_COLORS[presetCount % AUTO_TAG_COLORS.length];
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The theme attribute drives both our token sets and Radix's scales. */
export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  return root.dataset.theme === "dark" || root.classList.contains("dark");
}

export interface ChipColors {
  background: string;
  color: string;
  /** One hairline in the hue's border step. */
  borderColor: string;
}

export type ChipPalette = Record<PresetColor, ChipColors>;

export interface OptionPalette {
  byColor: ChipPalette;
  /** Fallback for values whose option no longer exists (renamed/deleted). */
  neutral: ChipColors;
  /** Resolve a preset token or a user-picked hex to chip colors. */
  resolve: (color: ColumnColor) => ChipColors;
}

function chipFromScale(scale: CustomScale): ChipColors {
  return {
    background: scale.chipBg,
    color: scale.chipFg,
    borderColor: scale.chipBorder,
  };
}

/**
 * Resolve the option-chip palette once per theme. Canvas drawing cannot read
 * CSS variables, so the custom cell renderer needs plain values up front.
 * Custom colors are derived on demand and cached for the lifetime of one theme.
 */
export function readOptionPalette(dark = isDarkTheme()): OptionPalette {
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
  const neutral: ChipColors = {
    background: cssVar("--bg-hover"),
    color: cssVar("--text-mid"),
    borderColor: cssVar("--border-strong"),
  };
  const custom = new Map<string, ChipColors>();
  return {
    byColor,
    neutral,
    resolve: (color) => {
      if (isPresetColor(color)) return byColor[color];
      const cached = custom.get(color);
      if (cached) return cached;
      const chip = chipFromScale(customScale(color, dark));
      custom.set(color, chip);
      return chip;
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
 * palette only changes backgrounds). Hover variants are explicit — without
 * them Glide falls back to the global surface and flashes on hover.
 */
export function tagThemeOverride(color: ColumnColor): Partial<Theme> {
  if (!isPresetColor(color)) {
    const scale = customScale(color, isDarkTheme());
    return {
      bgHeader: scale.headerBg,
      bgHeaderHovered: scale.headerBg,
      bgHeaderHasFocus: scale.headerBg,
      textHeader: scale.headerFg,
      bgCell: scale.cellBg,
      bgCellMedium: scale.cellHover,
    };
  }
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
export function chipStyle(color: ColumnColor): {
  background: string;
  color: string;
  border: string;
} {
  if (!isPresetColor(color)) {
    const scale = customScale(color, isDarkTheme());
    return {
      background: scale.chipBg,
      color: scale.chipFg,
      border: `1px solid ${scale.chipBorder}`,
    };
  }
  return {
    background: cssVar(`--chip-${color}-bg`),
    color: cssVar(`--chip-${color}-fg`),
    border: `1px solid ${cssVar(`--chip-${color}-border`)}`,
  };
}

/** Solid, vivid dot for the palette picker. */
export function swatchStyle(color: ColumnColor): { background: string; color: string } {
  if (!isPresetColor(color)) {
    const scale = customScale(color, isDarkTheme());
    return { background: scale.swatchBg, color: scale.swatchFg };
  }
  return {
    background: cssVar(`--swatch-${color}-bg`),
    color: cssVar(`--swatch-${color}-fg`),
  };
}

/** Grid header tint matching a palette column. */
export function headerStyle(color: ColumnColor): { background: string; color: string } {
  if (!isPresetColor(color)) {
    const scale = customScale(color, isDarkTheme());
    return { background: scale.headerBg, color: scale.headerFg };
  }
  return {
    background: cssVar(`--tag-${color}-header-bg`),
    color: cssVar(`--tag-${color}-header-fg`),
  };
}

/** Cell background matching a palette column (used by the header preview). */
export function cellStyle(color: ColumnColor): { background: string } {
  if (!isPresetColor(color)) {
    return { background: customScale(color, isDarkTheme()).cellBg };
  }
  return { background: cssVar(`--tag-${color}-cell-bg`) };
}