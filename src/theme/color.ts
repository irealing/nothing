// Color math for user-picked colors.
//
// The curated palette is resolved from CSS tokens, but a custom color is an
// arbitrary `#rrggbb` value. Every presentation shade (chip, swatch, header,
// cell tint) is derived here so the rest of the app only deals with ready-made
// color strings. Derivation is theme-aware and keeps chip text readable; the
// contrast guarantees are covered by unit tests.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** Hue in degrees, 0–360. */
  h: number;
  /** Saturation, 0–1. */
  s: number;
  /** Lightness, 0–1. */
  l: number;
}

const HEX_BODY = /^[0-9a-fA-F]+$/;

/** Parse `#rgb` or `#rrggbb`; anything else returns `null`. */
export function parseHex(value: string): Rgb | null {
  const raw = value.trim();
  if (!raw.startsWith("#")) return null;
  const body = raw.slice(1);
  if (!HEX_BODY.test(body)) return null;
  if (body.length === 3) {
    const [r, g, b] = Array.from(body, (c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  if (body.length !== 6) return null;
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

export function isHexColor(value: string): value is `#${string}` {
  return parseHex(value) !== null;
}

/** Canonical lowercase `#rrggbb`, or `null` when the input is not a color. */
export function normalizeHex(value: string): `#${string}` | null {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : null;
}

export function toHex({ r, g, b }: Rgb): `#${string}` {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255),
  };
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two colors (1–21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black, whichever reads better on `bg`. */
export function readableText(bg: Rgb, dark = "#111111", light = "#ffffff"): string {
  const darkRgb = parseHex(dark) ?? { r: 17, g: 17, b: 17 };
  const lightRgb = parseHex(light) ?? { r: 255, g: 255, b: 255 };
  return contrastRatio(bg, darkRgb) >= contrastRatio(bg, lightRgb) ? dark : light;
}

function cssHsl(h: number, s: number, l: number): string {
  const hue = Math.round(((h % 360) + 360) % 360);
  const sat = Math.round(Math.min(1, Math.max(0, s)) * 1000) / 10;
  const lit = Math.round(Math.min(1, Math.max(0, l)) * 1000) / 10;
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

export interface CustomScale {
  chipBg: string;
  chipFg: string;
  chipBorder: string;
  swatchBg: string;
  swatchFg: string;
  headerBg: string;
  headerFg: string;
  cellBg: string;
  cellHover: string;
}

/**
 * Pick a foreground lightness that actually clears WCAG AA against `bg`.
 * Hue and saturation stay fixed, so the text keeps the picked color family.
 */
function readableHsl(h: number, s: number, bg: Rgb, startL: number, dir: -1 | 1): string {
  let l = startL;
  for (let i = 0; i < 48; i += 1) {
    if (contrastRatio(hslToRgb({ h, s, l }), bg) >= 4.6) return cssHsl(h, s, l);
    l += dir * 0.02;
    if (l <= 0.08 || l >= 0.98) break;
  }
  return cssHsl(h, s, Math.min(0.98, Math.max(0.08, l)));
}

/**
 * Derive every presentation shade from one picked color.
 *
 * Hue is preserved; saturation is scaled per surface so tints stay quiet.
 * Light and dark themes use different lightness targets rather than reusing
 * the picked value, which would be unreadable in one of the two themes.
 */
export function customScale(hex: string, dark: boolean): CustomScale {
  const rgb = parseHex(hex) ?? { r: 100, g: 116, b: 139 };
  const { h, s } = rgbToHsl(rgb);
  if (dark) {
    const chipBg = cssHsl(h, s * 0.45, 0.24);
    const headerBg = cssHsl(h, s * 0.4, 0.29);
    return {
      chipBg,
      chipFg: readableHsl(h, s * 0.65, hslToRgb({ h, s: s * 0.45, l: 0.24 }), 0.84, 1),
      chipBorder: cssHsl(h, s * 0.4, 0.37),
      swatchBg: toHex(rgb),
      swatchFg: readableText(rgb),
      headerBg,
      headerFg: readableHsl(h, s * 0.55, hslToRgb({ h, s: s * 0.4, l: 0.29 }), 0.88, 1),
      cellBg: cssHsl(h, s * 0.4, 0.16),
      cellHover: cssHsl(h, s * 0.45, 0.21),
    };
  }
  const chipBg = cssHsl(h, s * 0.6, 0.94);
  const headerBg = cssHsl(h, s * 0.45, 0.88);
  return {
    chipBg,
    chipFg: readableHsl(h, s * 0.8, hslToRgb({ h, s: s * 0.6, l: 0.94 }), 0.3, -1),
    chipBorder: cssHsl(h, s * 0.45, 0.8),
    swatchBg: toHex(rgb),
    swatchFg: readableText(rgb),
    headerBg,
    headerFg: readableHsl(h, s * 0.8, hslToRgb({ h, s: s * 0.45, l: 0.88 }), 0.29, -1),
    cellBg: cssHsl(h, s * 0.4, 0.965),
    cellHover: cssHsl(h, s * 0.45, 0.945),
  };
}