import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  customScale,
  hslToRgb,
  normalizeHex,
  parseHex,
  readableText,
  rgbToHsl,
  type Rgb,
} from "./color";

/** Convert one of our own `hsl(h, s%, l%)` strings back to RGB. */
function hslStringToRgb(value: string): Rgb {
  const match = value.match(/^hsl\((\d+), ([\d.]+)%, ([\d.]+)%\)$/);
  if (!match) throw new Error(`unexpected hsl string: ${value}`);
  return hslToRgb({ h: Number(match[1]), s: Number(match[2]) / 100, l: Number(match[3]) / 100 });
}

describe("hex parsing", () => {
  it("expands short form and lowercases six-digit values", () => {
    expect(normalizeHex("#fb0")).toBe("#ffbb00");
    expect(normalizeHex("#3B82F6")).toBe("#3b82f6");
    expect(parseHex("#3b82f6")).toEqual({ r: 59, g: 130, b: 246 });
  });

  it("rejects anything that is not #rgb or #rrggbb", () => {
    for (const bad of ["3b82f6", "#12345", "#gggggg", "rgb(1,2,3)", "#", ""]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe("HSL round trip", () => {
  it("returns the original color", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#808080", "#3b82f6"]) {
      const rgb = parseHex(hex)!;
      expect(normalizeHex(hex)).toBe(hex);
      const back = hslToRgb(rgbToHsl(rgb));
      expect(back).toEqual(rgb);
    }
  });
});

describe("readableText", () => {
  it("picks the higher-contrast text color", () => {
    expect(readableText({ r: 255, g: 255, b: 255 })).toBe("#111111");
    expect(readableText({ r: 0, g: 0, b: 0 })).toBe("#ffffff");
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
  });
});

describe("customScale", () => {
  const colors = [
    "#e5484d",
    "#f76b15",
    "#ffb224",
    "#f5d90a",
    "#99d52a",
    "#30a46c",
    "#12a594",
    "#00a2c7",
    "#0091ff",
    "#3e63dd",
    "#8e4ec6",
    "#e93d82",
  ];

  it("keeps chip and header text at a readable contrast in both themes", () => {
    for (const picked of colors) {
      for (const dark of [false, true]) {
        const scale = customScale(picked, dark);
        for (const [bg, fg] of [
          [scale.chipBg, scale.chipFg],
          [scale.headerBg, scale.headerFg],
        ]) {
          const ratio = contrastRatio(hslStringToRgb(bg), hslStringToRgb(fg));
          expect(ratio, `${picked} dark=${dark}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("derives different surfaces per theme instead of reusing the picked value", () => {
    const light = customScale("#3b82f6", false);
    const dark = customScale("#3b82f6", true);
    expect(light.chipBg).not.toBe(dark.chipBg);
    expect(light.cellBg).not.toBe(dark.cellBg);
    expect(light.swatchBg).toBe("#3b82f6");
    expect(dark.swatchBg).toBe("#3b82f6");
  });

  it("falls back to a neutral hue for unparseable input", () => {
    const scale = customScale("not-a-color", false);
    expect(scale.chipBg).toMatch(/^hsl\(/);
  });
});