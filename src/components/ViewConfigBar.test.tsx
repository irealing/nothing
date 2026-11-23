// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ColumnMeta, ViewMeta } from "../types";
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

afterEach(() => cleanup());

describe("ViewConfigBar", () => {
  it("starts collapsed and expands to readable filter/sort chips", async () => {
    const user = userEvent.setup();
    render(<ViewConfigBar view={VIEW} columns={[TITLE, STATUS]} onEdit={() => {}} />);

    const toggle = screen.getByRole("button", { name: /筛选 2 项 · 排序 1 项/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("🚧 进行中")).toBeNull();

    await user.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("状态")).toBeTruthy();
    expect(screen.getByText("等于")).toBeTruthy();
    expect(screen.getByText("🚧 进行中")).toBeTruthy();
    expect(screen.getAllByText("标题").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("降序")).toBeTruthy();
  });

  it("does not render when the view has no filters or sorts", () => {
    const empty: ViewMeta = {
      ...VIEW,
      data: { kind: "grid", filters: null, sorts: [] },
    };
    const { container } = render(
      <ViewConfigBar view={empty} columns={[TITLE, STATUS]} onEdit={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("opens the full panel from the edit action", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<ViewConfigBar view={VIEW} columns={[TITLE, STATUS]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});