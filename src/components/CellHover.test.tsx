// @vitest-environment jsdom
//
// The hover overlay is the only clickable part of the canvas grid, so pin both
// the copy call and the rule that empty / very narrow cells do not get a
// misleading button.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CellHover from "./CellHover";

const bounds = { x: 100, y: 50, width: 160, height: 36 };
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => cleanup());

describe("CellHover", () => {
  it("copies the cell text and flips to the copied state", async () => {
    render(<CellHover bounds={bounds} copyText="hello" />);

    fireEvent.click(screen.getByRole("button", { name: "复制内容" }));

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeTruthy();
  });

  it("keeps the highlight but hides the button for empty cells", () => {
    const { container } = render(<CellHover bounds={bounds} copyText="" />);
    expect(container.querySelector(".cell-hover")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("hides the button when the column is too narrow", () => {
    render(<CellHover bounds={{ ...bounds, width: 40 }} copyText="x" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});