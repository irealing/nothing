// @vitest-environment jsdom
//
// The column editor must never save a half-finished column: Enter only submits
// from the name field, option rows append instead, invalid choices are caught
// before the backend, and a rejected write keeps the dialog (and its input)
// on screen.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const addColumn = vi.fn();
const updateColumn = vi.fn();
const store = {
  addColumn,
  updateColumn,
  columns: [] as unknown[],
  tables: [] as unknown[],
  activeTableId: "t1",
};

vi.mock("../stores/workspace", () => ({
  useWorkspace: (selector: (s: typeof store) => unknown) => selector(store),
}));

import type { ColumnMeta } from "../types";
import ColumnDialog from "./ColumnDialogs";

const SELECT_COL: ColumnMeta = {
  id: "c1",
  table_id: "t1",
  name: "状态",
  position: 0,
  width: 160,
  icon: null,
  color: null,
  align: null,
  default_value: null,
  created_at: "",
  data: {
    kind: "select",
    sql_name: "c_status",
    choices: [{ id: "a", name: "待办", icon: null, color: null, position: 0 }],
  },
};

const TEXT_COL: ColumnMeta = {
  ...SELECT_COL,
  id: "c2",
  name: "备注",
  data: { kind: "text", sql_name: "c_note" },
};

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
  vi.clearAllMocks();
  updateColumn.mockResolvedValue(true);
  addColumn.mockResolvedValue(true);
});

afterEach(() => cleanup());

describe("ColumnDialog", () => {
  it("appends a new option on Enter instead of submitting", async () => {
    const user = userEvent.setup();
    render(<ColumnDialog existing={SELECT_COL} onClose={() => {}} />);

    const option = screen.getByPlaceholderText("选项 1");
    await user.click(option);
    await user.type(option, "中");
    await user.keyboard("{Enter}");

    expect(updateColumn).not.toHaveBeenCalled();
    expect(screen.getAllByPlaceholderText(/^选项 \d+$/)).toHaveLength(2);
  });

  it("blocks saving when an option name is blank", async () => {
    const user = userEvent.setup();
    const blank: ColumnMeta = {
      ...SELECT_COL,
      data: {
        kind: "select",
        sql_name: "c_status",
        choices: [{ id: "a", name: "  ", icon: null, color: null, position: 0 }],
      },
    };
    render(<ColumnDialog existing={blank} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("选项名不能为空")).toBeTruthy();
    expect(updateColumn).not.toHaveBeenCalled();
  });

  it("blocks saving when two options share a name", async () => {
    const user = userEvent.setup();
    const dup: ColumnMeta = {
      ...SELECT_COL,
      data: {
        kind: "select",
        sql_name: "c_status",
        choices: [
          { id: "a", name: "待办", icon: null, color: null, position: 0 },
          { id: "b", name: "待办", icon: null, color: null, position: 1 },
        ],
      },
    };
    render(<ColumnDialog existing={dup} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("选项名不能重复")).toBeTruthy();
    expect(updateColumn).not.toHaveBeenCalled();
  });

  it("submits option color changes even when names are unchanged", async () => {
    const user = userEvent.setup();
    render(<ColumnDialog existing={SELECT_COL} onClose={() => {}} />);

    // Two color triggers: the column's and the option row's (last one).
    const colorTriggers = screen.getAllByRole("button", { name: "颜色" });
    await user.click(colorTriggers[colorTriggers.length - 1]);
    await user.click(await screen.findByRole("radio", { name: "blue" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateColumn).toHaveBeenCalledTimes(1));
    expect(updateColumn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        choices: [expect.objectContaining({ id: "a", name: "待办", color: "blue" })],
      }),
    );
  });

  it("gives a newly added option an unused color automatically", async () => {
    const user = userEvent.setup();
    render(<ColumnDialog existing={SELECT_COL} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "添加选项" }));
    await user.type(screen.getByPlaceholderText("选项 2"), "进行中");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateColumn).toHaveBeenCalledTimes(1));
    expect(updateColumn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        choices: [
          expect.objectContaining({ name: "待办" }),
          expect.objectContaining({ name: "进行中", color: "blue" }),
        ],
      }),
    );
  });

  it("stays open when the backend rejects the change", async () => {
    const user = userEvent.setup();
    updateColumn.mockResolvedValue(false);
    render(<ColumnDialog existing={TEXT_COL} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateColumn).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
    expect(screen.getByDisplayValue("备注")).toBeTruthy();
  });

  it("adds options from the header action", async () => {
    const user = userEvent.setup();
    render(<ColumnDialog existing={SELECT_COL} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "添加选项" }));

    expect(screen.getAllByPlaceholderText(/^选项 \d+$/)).toHaveLength(2);
  });

  it("greys out the default value control until it is enabled", async () => {
    const user = userEvent.setup();
    render(<ColumnDialog existing={TEXT_COL} onClose={() => {}} />);

    const value = screen.getByPlaceholderText("新行默认填这个值") as HTMLInputElement;
    expect(value.disabled).toBe(true);

    await user.click(screen.getByText("新行使用默认值"));
    expect(value.disabled).toBe(false);
  });
});