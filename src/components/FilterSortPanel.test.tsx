// @vitest-environment jsdom
//
// The filter panel and the inline view-config bar share one rule editor.
// These tests pin the behaviours that used to fall back to free text:
// a single choice, an "in list" multi-choice, an empty select, independent
// pickers per select column, and the token-styled hidden-column checkbox.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ColumnMeta, ViewMeta } from "../types";
import { useWorkspace } from "../stores/workspace";
import FilterSortPanel from "./FilterSortPanel";

const CH_STATUS = {
  id: "o1",
  name: "进行中",
  icon: "🚧",
  color: "blue" as const,
  position: 0,
};
const CH_DONE = {
  id: "o2",
  name: "已完成",
  icon: "✅",
  color: "green" as const,
  position: 1,
};

function column(
  id: string,
  name: string,
  type: "text" | "select" | "multi_select",
): ColumnMeta {
  return {
    id,
    table_id: "t1",
    name,
    position: 0,
    width: 160,
    icon: null,
    color: null,
    align: null,
    default_value: null,
    format: null,
    created_at: "",
    data:
      type === "select"
        ? { kind: "select", sql_name: `c_${id}`, choices: [CH_STATUS, CH_DONE] }
        : type === "multi_select"
          ? { kind: "multi_select", sql_name: `c_${id}`, choices: [CH_STATUS, CH_DONE] }
          : { kind: "text", sql_name: `c_${id}` },
  };
}

const TEXT = column("c1", "标题", "text");
const STATUS = column("c2", "状态", "select");
const TAGS = column("c3", "标签", "multi_select");
const EMPTY_SELECT: ColumnMeta = {
  ...column("c4", "空列表", "select"),
  data: { kind: "select", sql_name: "c_c4", choices: [] },
};
const PRIORITY: ColumnMeta = {
  ...column("c5", "优先级", "select"),
  data: {
    kind: "select",
    sql_name: "c_c5",
    choices: [
      { id: "p1", name: "高", icon: null, color: "red", position: 0 },
      { id: "p2", name: "低", icon: null, color: "gray", position: 1 },
    ],
  },
};

function viewWith(filters: unknown, sorts: { column_id: string; desc: boolean }[] = []): ViewMeta {
  return {
    id: "v1",
    table_id: "t1",
    name: "默认视图",
    kind: "grid",
    icon: null,
    color: null,
    position: 0,
    created_at: "",
    data: {
      kind: "grid",
      filters: filters as never,
      sorts,
    },
    columns: [TEXT, STATUS, TAGS].map((c, i) => ({
      id: `vc${i}`,
      column_id: c.id,
      position: i,
      width: 160,
      hidden: false,
      frozen: false,
    })),
  };
}

let updateView = vi.fn(async (_viewId: string, _patch: unknown) => {});
let updateViewColumn = vi.fn(async (_viewId: string, _columnId: string, _patch: unknown) => {});

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
  updateView = vi.fn(async (_viewId: string, _patch: unknown) => {});
  updateViewColumn = vi.fn(async (_viewId: string, _columnId: string, _patch: unknown) => {});
  useWorkspace.setState({
    columns: [TEXT, STATUS, TAGS],
    updateView: updateView as never,
    updateViewColumn: updateViewColumn as never,
  });
});

afterEach(() => cleanup());

describe("FilterSortPanel values", () => {
  it("offers select choices for a single-value rule", async () => {
    const user = userEvent.setup();
    const view = viewWith({
      op: "and",
      children: [{ column_id: STATUS.id, op: "eq", value: "" }],
    });
    render(<FilterSortPanel view={view} onClose={() => {}} />);

    await user.click(screen.getByRole("combobox", { name: "值" }));
    await user.click(await screen.findByRole("option", { name: /🚧 进行中/ }));
    await user.click(screen.getByRole("button", { name: "保存并应用" }));

    await waitFor(() => expect(updateView).toHaveBeenCalledTimes(1));
    const patch = updateView.mock.calls[0][1] as { data: { filters: unknown } };
    expect(patch.data.filters).toEqual({
      op: "and",
      children: [{ column_id: STATUS.id, op: "eq", value: "进行中" }],
    });
  });

  it("uses a multi-choice picker for in/not_in and stores an array", async () => {
    const user = userEvent.setup();
    const view = viewWith({
      op: "and",
      children: [{ column_id: TAGS.id, op: "in", value: [] }],
    });
    render(<FilterSortPanel view={view} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "值" }));
    await user.click(await screen.findByText("🚧 进行中"));
    await user.click(screen.getByText("✅ 已完成"));
    await user.click(screen.getByRole("button", { name: "保存并应用" }));

    await waitFor(() => expect(updateView).toHaveBeenCalledTimes(1));
    const patch = updateView.mock.calls[0][1] as { data: { filters: unknown } };
    expect(patch.data.filters).toEqual({
      op: "and",
      children: [{ column_id: TAGS.id, op: "in", value: ["进行中", "已完成"] }],
    });
  });

  it("toggles hidden columns through the shared checkbox", async () => {
    const user = userEvent.setup();
    render(<FilterSortPanel view={viewWith(null)} onClose={() => {}} />);

    await user.click(screen.getByText("标题"));

    await waitFor(() =>
      expect(updateViewColumn).toHaveBeenCalledWith("v1", TEXT.id, { hidden: true }),
    );
  });

  it("renders an independent picker for every select column", async () => {
    const user = userEvent.setup();
    useWorkspace.setState({ columns: [TEXT, STATUS, TAGS, PRIORITY] });
    const view = viewWith({
      op: "and",
      children: [
        { column_id: STATUS.id, op: "eq", value: "" },
        { column_id: PRIORITY.id, op: "eq", value: "" },
      ],
    });
    render(<FilterSortPanel view={view} onClose={() => {}} />);

    const triggers = screen.getAllByRole("combobox", { name: "值" });
    expect(triggers).toHaveLength(2);

    await user.click(triggers[0]);
    expect(await screen.findByRole("option", { name: /🚧 进行中/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "高" })).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(triggers[1]);
    expect(await screen.findByRole("option", { name: "高" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /🚧 进行中/ })).toBeNull();
  });

  it("explains an empty select instead of falling back to free text", () => {
    useWorkspace.setState({ columns: [TEXT, EMPTY_SELECT, STATUS, TAGS] });
    const view = viewWith({
      op: "and",
      children: [{ column_id: EMPTY_SELECT.id, op: "eq", value: "" }],
    });
    render(<FilterSortPanel view={view} onClose={() => {}} />);

    expect(screen.getByText("该列还没有选项，请先在列设置中添加")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "值" })).toBeNull();
  });

  it("labels a filter whose column no longer exists", () => {
    const view = viewWith({
      op: "and",
      children: [{ column_id: "deleted", op: "eq", value: "" }],
    });
    render(<FilterSortPanel view={view} onClose={() => {}} />);

    expect(screen.getAllByText("已删除的列").length).toBeGreaterThanOrEqual(1);
  });
});