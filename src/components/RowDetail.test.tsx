// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const updateCell = vi.fn();
const store = {
  columns: [] as unknown[],
  tables: [] as unknown[],
  updateCell,
};

vi.mock("../stores/workspace", () => ({
  useWorkspace: (selector: (s: typeof store) => unknown) => selector(store),
}));

vi.mock("../ipc");

import * as ipc from "../ipc";
import type { ColumnMeta, RowDetail as RowDetailData } from "../types";
import RowDetail from "./RowDetail";

const TITLE: ColumnMeta = {
  id: "c1",
  table_id: "t1",
  name: "Title",
  position: 0,
  width: 160,
  icon: null,
  color: null,
  align: null,
  default_value: null,
  format: null,
  created_at: "",
  data: { kind: "text", sql_name: "c_title" },
};

const DONE: ColumnMeta = {
  ...TITLE,
  id: "c2",
  name: "Done",
  position: 1,
  data: { kind: "checkbox", sql_name: "c_done" },
};

const OWNER: ColumnMeta = {
  ...TITLE,
  id: "c3",
  name: "Owner",
  position: 2,
  data: {
    kind: "relation",
    target_table_id: "t2",
    single: false,
    origin_id: null,
  },
};

const TOTAL: ColumnMeta = {
  ...TITLE,
  id: "c4",
  name: "Total",
  position: 3,
  format: { kind: "number", style: "currency", currency: "usd", decimals: 2, thousands: true },
  data: {
    kind: "formula",
    sql_name: "c_total",
    expr: "[c_done]",
    result_type: "number",
  },
};

const TABLE = {
  id: "t1",
  name: "Tasks",
  sql_name: "t_x",
  title_col_id: "c1",
  icon: null,
  color: null,
  position: 0,
  created_at: "",
  updated_at: "",
};

const DETAIL: RowDetailData = {
  row: {
    rid: "r1",
    created: "2024-01-02T03:04:05Z",
    updated: "2024-01-02T03:04:05Z",
    cells: {
      c1: "Alice",
      c2: false,
      c3: ["e1"],
      c4: 42,
    },
  },
  titles: { e1: "Bob" },
};

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RowDetail", () => {
  it("renders every field, resolves relation titles and formats formulas", async () => {
    store.columns = [TITLE, DONE, OWNER, TOTAL];
    store.tables = [TABLE];
    vi.mocked(ipc.rowDetail).mockResolvedValue(DETAIL);

    render(<RowDetail tableId="t1" rid="r1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByDisplayValue("Alice")).toBeTruthy());
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText(/42\.00/)).toBeTruthy();
  });

  it("commits a checkbox toggle through updateCell", async () => {
    store.columns = [TITLE, DONE];
    store.tables = [TABLE];
    vi.mocked(ipc.rowDetail).mockResolvedValue(DETAIL);
    updateCell.mockResolvedValue({
      ...DETAIL.row,
      cells: { ...DETAIL.row.cells, c2: true },
    });

    render(<RowDetail tableId="t1" rid="r1" onClose={() => {}} />);
    const checkbox = await screen.findByRole("checkbox");
    await userEvent.click(checkbox);
    expect(updateCell).toHaveBeenCalledWith("r1", "c2", true);
  });

  it("shows a deleted notice when the row is gone", async () => {
    store.columns = [TITLE];
    store.tables = [TABLE];
    vi.mocked(ipc.rowDetail).mockRejectedValue(new Error("not found"));

    render(<RowDetail tableId="t1" rid="r1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("该行已被删除")).toBeTruthy());
  });
});