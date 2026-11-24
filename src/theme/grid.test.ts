import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTO_TAG_COLORS, TAG_COLORS, pickAutoColor } from "./grid";

describe("pickAutoColor", () => {
  it("starts with a vivid color and skips ones already in use", () => {
    expect(pickAutoColor([])).toBe("blue");
    expect(pickAutoColor(["blue"])).toBe("purple");
    expect(pickAutoColor([null, "blue", "purple"])).toBe("green");
  });

  it("ignores custom colors and still assigns the next free preset", () => {
    expect(pickAutoColor(["#3b82f6", "blue"])).toBe("purple");
    expect(pickAutoColor(["#ff0000", "#00ff00"])).toBe("blue");
  });

  it("cycles once every palette color is taken", () => {
    expect(pickAutoColor(AUTO_TAG_COLORS)).toBe("blue");
    expect(pickAutoColor([...AUTO_TAG_COLORS, "blue"])).toBe("purple");
  });

  it("keeps the auto palette inside the curated palette", () => {
    expect(new Set(AUTO_TAG_COLORS).size).toBe(AUTO_TAG_COLORS.length);
    expect(new Set(AUTO_TAG_COLORS).size).toBe(TAG_COLORS.length);
    for (const color of AUTO_TAG_COLORS) {
      expect(TAG_COLORS).toContain(color);
    }
  });
});

describe("palette stylesheet", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const tokens = [
    "--chip-%s-bg",
    "--chip-%s-fg",
    "--chip-%s-border",
    "--swatch-%s-bg",
    "--swatch-%s-fg",
    "--tag-%s-cell-bg",
    "--tag-%s-cell-bg-hover",
  ];

  it("defines every presentation token for every palette color", () => {
    for (const color of TAG_COLORS) {
      for (const pattern of tokens) {
        const name = pattern.replace("%s", color);
        expect(css, `${name} is missing`).toContain(`${name}:`);
      }
    }
  });

  it("imports the light and dark Radix scales for every color", () => {
    for (const color of TAG_COLORS) {
      expect(css).toContain(`@radix-ui/colors/${color}.css`);
      expect(css).toContain(`@radix-ui/colors/${color}-dark.css`);
    }
  });

  it("defines the SQL editor syntax tokens", () => {
    for (const token of [
      "--syntax-keyword",
      "--syntax-string",
      "--syntax-number",
      "--syntax-function",
      "--syntax-type",
    ]) {
      expect(css, `${token} is missing`).toContain(`${token}:`);
    }
  });
});