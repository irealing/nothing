import { describe, expect, it } from "vitest";
import { AUTO_TAG_COLORS, pickAutoColor } from "./grid";

describe("pickAutoColor", () => {
  it("starts with a vivid color and skips ones already in use", () => {
    expect(pickAutoColor([])).toBe("blue");
    expect(pickAutoColor(["blue"])).toBe("purple");
    expect(pickAutoColor([null, "blue", "purple"])).toBe("green");
  });

  it("cycles once every palette color is taken", () => {
    expect(pickAutoColor(AUTO_TAG_COLORS)).toBe("blue");
    expect(pickAutoColor([...AUTO_TAG_COLORS, "blue"])).toBe("purple");
  });
});