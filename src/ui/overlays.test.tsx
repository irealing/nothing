// @vitest-environment jsdom
//
// Behaviour tests for the primitive layer. These guard the two things the old
// hand-rolled overlays got wrong: menus must portal out of `overflow: auto`
// containers, and dialogs must handle Escape + outside clicks.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { Dialog } from "../ui/Dialog";
import { Menu, MenuItem } from "../ui/Menu";
import { confirm, ConfirmHost } from "../ui/ConfirmDialog";

beforeAll(() => {
  // Radix popper/menu relies on a few APIs jsdom does not implement.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => cleanup());

function TabStripMenu() {
  const [picked, setPicked] = useState("");
  return (
    <div style={{ overflowX: "auto", height: 40 }}>
      <div style={{ position: "relative" }}>
        <Menu
          ariaLabel="new view"
          trigger={<button type="button">＋</button>}
        >
          <MenuItem onSelect={() => setPicked("grid")}>新建网格视图</MenuItem>
          <MenuItem onSelect={() => setPicked("sql")}>新建 SQL 视图</MenuItem>
        </Menu>
      </div>
      <span data-testid="picked">{picked}</span>
    </div>
  );
}

describe("Menu", () => {
  it("portals its content to <body> so overflow containers cannot clip it", async () => {
    const user = userEvent.setup();
    const { container } = render(<TabStripMenu />);

    await user.click(screen.getByRole("button", { name: "＋" }));
    const menu = await screen.findByRole("menu");
    // Escaped the clipped tab strip entirely.
    expect(container.contains(menu)).toBe(false);
    expect(menu.closest("body")).toBe(document.body);
    expect(menu.parentElement?.parentElement).toBe(document.body);
  });

  it("selects an item and closes", async () => {
    const user = userEvent.setup();
    render(<TabStripMenu />);
    await user.click(screen.getByRole("button", { name: "＋" }));
    await user.click(await screen.findByRole("menuitem", { name: "新建 SQL 视图" }));
    expect(screen.getByTestId("picked").textContent).toBe("sql");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("Dialog", () => {
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Dialog title="新建表格" onClose={onClose}>
        <p>body</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("新建表格")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("closes when the overlay is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog title="新建表格" onClose={onClose}>
        <p>body</p>
      </Dialog>,
    );
    const overlay = document.querySelector(".modal-backdrop");
    expect(overlay).toBeTruthy();
    await user.click(overlay as Element);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("confirm()", () => {
  it("resolves true when confirmed and false when cancelled", async () => {
    const user = userEvent.setup();
    render(<ConfirmHost />);

    const yes = confirm({ title: "删除视图", description: "不可恢复", confirmLabel: "删除" });
    await user.click(await screen.findByRole("button", { name: "删除" }));
    await expect(yes).resolves.toBe(true);

    const no = confirm({ title: "删除视图" });
    await user.click(await screen.findByRole("button", { name: "取消" }));
    await expect(no).resolves.toBe(false);
  });
});