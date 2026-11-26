// @vitest-environment jsdom
//
// A table's implicit default view is recreated on demand, so the last grid
// view must not advertise a delete action. Extra views still can be removed.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ViewMeta } from "../types";
import { useWorkspace } from "../stores/workspace";
import ViewTabs from "./ViewTabs";

function gridView(id: string, name: string, position: number): ViewMeta {
  return {
    id,
    table_id: "t1",
    name,
    kind: "grid",
    icon: null,
    color: null,
    position,
    created_at: "",
    data: { kind: "grid", filters: null, sorts: [] },
    columns: [],
  };
}

const V1 = gridView("v1", "默认视图", 0);
const V2 = gridView("v2", "本周", 1);

function sqlView(id: string, name: string, position: number): ViewMeta {
  return {
    id,
    table_id: null,
    name,
    kind: "sql",
    icon: null,
    color: null,
    position,
    created_at: "",
    data: { kind: "sql", statement: "SELECT 1" },
    columns: [],
  };
}

beforeAll(() => {
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
});

beforeEach(() => {
  useWorkspace.setState({
    activeTableId: "t1",
    activeViewId: V1.id,
    views: [V1],
  });
});

afterEach(() => cleanup());

describe("ViewTabs grid view menu", () => {
  it("hides delete when only the implicit grid view remains", async () => {
    const user = userEvent.setup();
    render(<ViewTabs hasTable />);
    await user.click(screen.getByRole("button", { name: "重命名" }));
    expect(await screen.findByText("重命名")).toBeTruthy();
    expect(screen.queryByText("删除视图")).toBeNull();
  });

  it("offers delete once there is more than one grid view", async () => {
    useWorkspace.setState({ views: [V1, V2] });
    const user = userEvent.setup();
    render(<ViewTabs hasTable />);
    await user.click(screen.getByRole("button", { name: "重命名" }));
    expect(await screen.findByText("删除视图")).toBeTruthy();
  });

  it("edits the view icon from the tab menu", async () => {
    const updateView = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ updateView });
    const user = userEvent.setup();
    render(<ViewTabs hasTable />);
    await user.click(screen.getByRole("button", { name: "重命名" }));
    await user.click(await screen.findByText("修改视图图标"));
    // jsdom cannot emulate the submenu's pointer hover chain; a click event is
    // what the real browser sends to the item.
    fireEvent.click(await screen.findByRole("menuitem", { name: "🔥" }));
    expect(updateView).toHaveBeenCalledWith(V1.id, { icon: "🔥" });
  });

  it("renders a custom view icon instead of the default glyph", () => {
    useWorkspace.setState({ views: [{ ...V1, icon: "📊" }] });
    render(<ViewTabs hasTable />);
    expect(screen.getByText("📊")).toBeTruthy();
  });

  it("moves the active view with the tab menu", async () => {
    const updateView = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ views: [V1, V2], updateView });
    const user = userEvent.setup();
    render(<ViewTabs hasTable />);
    await user.click(screen.getByRole("button", { name: "重命名" }));

    const left = await screen.findByRole("menuitem", { name: "向左移动" });
    expect(left.getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("menuitem", { name: "向右移动" }));
    expect(updateView).toHaveBeenCalledWith(V1.id, { position: 1 });
  });

  it("disables moving the last view to the right", async () => {
    const updateView = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ views: [V1, V2], activeViewId: V2.id, updateView });
    const user = userEvent.setup();
    render(<ViewTabs hasTable />);
    await user.click(screen.getByRole("button", { name: "重命名" }));

    const right = await screen.findByRole("menuitem", { name: "向右移动" });
    expect(right.getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("menuitem", { name: "向左移动" }));
    expect(updateView).toHaveBeenCalledWith(V2.id, { position: 0 });
  });

  it("reorders SQL views separately from grid views", async () => {
    const updateView = vi.fn().mockResolvedValue(undefined);
    const S1 = sqlView("s1", "统计", 0);
    const S2 = sqlView("s2", "明细", 1);
    useWorkspace.setState({ views: [V1, S1, S2], activeViewId: S1.id, updateView });
    const user = userEvent.setup();
    render(<ViewTabs hasTable />);
    await user.click(screen.getByRole("button", { name: "重命名" }));

    await user.click(await screen.findByRole("menuitem", { name: "向右移动" }));
    expect(updateView).toHaveBeenCalledWith(S1.id, { position: 1 });
  });

  it("reorders tabs by drag and drop", () => {
    const updateView = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ views: [V1, V2], updateView });
    render(<ViewTabs hasTable />);

    const first = screen.getByText(V1.name).closest(".view-tab")!;
    const second = screen.getByText(V2.name).closest(".view-tab")!;
    fireEvent.dragStart(second);
    fireEvent.dragOver(first, { clientX: 0 });
    fireEvent.drop(first, { clientX: 0 });

    expect(updateView).toHaveBeenCalledWith(V2.id, { position: 0 });
  });
});