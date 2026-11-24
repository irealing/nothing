// @vitest-environment jsdom
//
// The summary bar is collapsed by default, but expanding it is an editor:
// the same filter/sort controls as the modal panel, with draft save/cancel.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ColumnMeta, ViewMeta } from "../types";
import { useWorkspace } from "../stores/workspace";
import ViewConfigBar from "./ViewConfigBar";

const TITLE: ColumnMeta = {
  id: "c1",
  table_id: "t1",
  name: "标题",
  position: 0,
  width: 160,
  icon: null,
  color: null,
  align: null,
  default_value: null,
  format: null,
  created_at: "",
  data: { kind: "text", sql_name: "c_1" },
};

const STATUS: ColumnMeta = {
  ...TITLE,
  id: "c2",
  name: "状态",
  position: 1,
  data: {
    kind: "select",
    sql_name: "c_2",
    choices: [{ id: "o1", name: "进行中", icon: "🚧", color: "blue", position: 0 }],
  },
};

const VIEW: ViewMeta = {
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
    filters: {
      op: "and",
      children: [
        { column_id: STATUS.id, op: "eq", value: "进行中" },
        { column_id: TITLE.id, op: "contains", value: "周报" },
      ],
    },
    sorts: [{ column_id: TITLE.id, desc: true }],
  },
  columns: [],
};

let updateView = vi.fn(async (_viewId: string, _patch: unknown) => {});

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
  useWorkspace.setState({ updateView: updateView as never });
});

afterEach(() => cleanup());

describe("ViewConfigBar", () => {
  it("starts collapsed and expands into an editable rule list", async () => {
    const user = userEvent.setup();
    render(<ViewConfigBar view={VIEW} columns={[TITLE, STATUS]} onOpenPanel={() => {}} />);

    const toggle = screen.getByRole("button", { name: /筛选 2 项 · 排序 1 项/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByDisplayValue("周报")).toBeNull();

    await user.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByDisplayValue("周报")).toBeTruthy();
    expect(screen.getByText(/🚧 进行中/)).toBeTruthy();
    expect(screen.getByText("降序")).toBeTruthy();
  });

  it("saves an edited rule without leaving the bar", async () => {
    const user = userEvent.setup();
    render(<ViewConfigBar view={VIEW} columns={[TITLE, STATUS]} onOpenPanel={() => {}} />);

    await user.click(screen.getByRole("button", { name: /筛选 2 项/ }));
    const value = screen.getByDisplayValue("周报");
    await user.clear(value);
    await user.type(value, "月报");
    await user.click(screen.getByRole("button", { name: "保存并应用" }));

    await waitFor(() => expect(updateView).toHaveBeenCalledTimes(1));
    const patch = updateView.mock.calls[0][1] as { data: { filters: unknown; sorts: unknown } };
    expect(patch.data.filters).toEqual({
      op: "and",
      children: [
        { column_id: STATUS.id, op: "eq", value: "进行中" },
        { column_id: TITLE.id, op: "contains", value: "月报" },
      ],
    });
    expect(patch.data.sorts).toEqual([{ column_id: TITLE.id, desc: true }]);
  });

  it("discards the draft on cancel and on reset", async () => {
    const user = userEvent.setup();
    render(<ViewConfigBar view={VIEW} columns={[TITLE, STATUS]} onOpenPanel={() => {}} />);

    await user.click(screen.getByRole("button", { name: /筛选 2 项/ }));
    await user.clear(screen.getByDisplayValue("周报"));
    await user.type(screen.getByDisplayValue(""), "草稿");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: /筛选 2 项/ }));

    expect(screen.getByDisplayValue("周报")).toBeTruthy();
    expect(screen.queryByDisplayValue("草稿")).toBeNull();

    await user.click(screen.getByRole("button", { name: "重置" }));
    expect(screen.getByText("没有筛选条件，显示全部行。")).toBeTruthy();
  });

  it("does not render when the view has no filters or sorts", () => {
    const empty: ViewMeta = {
      ...VIEW,
      data: { kind: "grid", filters: null, sorts: [] },
    };
    const { container } = render(
      <ViewConfigBar view={empty} columns={[TITLE, STATUS]} onOpenPanel={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("opens the full panel from the hidden-columns action", async () => {
    const user = userEvent.setup();
    const onOpenPanel = vi.fn();
    render(<ViewConfigBar view={VIEW} columns={[TITLE, STATUS]} onOpenPanel={onOpenPanel} />);
    await user.click(screen.getByRole("button", { name: "列显示…" }));
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
  });
});