// @vitest-environment jsdom
//
// The palette must expose the full curated set plus one custom entry, and the
// custom picker must hand back a normalized `#rrggbb` value.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-colorful", () => ({
  HexColorPicker: ({
    color,
    onChange,
  }: {
    color: string;
    onChange: (hex: string) => void;
  }) => (
    <button
      type="button"
      data-testid="hex-picker"
      data-color={color}
      onClick={() => onChange("#FF0000")}
    >
      hex
    </button>
  ),
}));

import { ColorSwatches } from "./ColumnPickers";
import { TAG_COLORS } from "../theme/grid";

afterEach(() => cleanup());

describe("ColorSwatches", () => {
  it("renders no-color, every preset and the custom entry", () => {
    render(<ColorSwatches value={null} onChange={() => {}} />);
    // none + presets + custom
    expect(screen.getAllByRole("radio")).toHaveLength(TAG_COLORS.length + 2);
    expect(screen.getByRole("radio", { name: "天蓝色" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "自定义颜色" })).toBeTruthy();
  });

  it("marks a custom value and seeds the picker with it", async () => {
    const user = userEvent.setup();
    render(<ColorSwatches value="#3b82f6" onChange={() => {}} />);

    const custom = screen.getByRole("radio", { name: "自定义颜色" });
    expect(custom.getAttribute("aria-checked")).toBe("true");

    await user.click(custom);
    const picker = screen.getByTestId("hex-picker");
    expect(picker.getAttribute("data-color")).toBe("#3b82f6");
  });

  it("emits a normalized hex when the custom picker changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ColorSwatches value={null} onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "自定义颜色" }));
    await user.click(screen.getByTestId("hex-picker"));

    expect(onChange).toHaveBeenLastCalledWith("#ff0000");
  });
});