// @vitest-environment jsdom
//
// The summary config panel is the only place that assembles an aggregate
// config; this keeps the draft → view update payload honest.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ColumnMeta, ViewMeta } from "../types";
import { useWorkspace } from "../stores/workspace";
import AggregateConfigPanel from "./AggregateConfigPanel";

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
  data: { kind: "select", sql_name: "c_2", choices: [] },
};

const VIEW: ViewMeta = {
  id: "va",
  table_id: "t1",
  name: "汇总",
  kind: "grid",
  icon: null,
  color: null,
  position: 0,
  created_at: "",
  data: {
    kind: "grid",
    filters: null,
    sorts: [],
    aggregate: {
      group_by: [],
      metrics: [{ op: "count_rows", column_id: null }],
      sort: null,
    },
  },
  columns: [],
};

let updateView = vi.fn(async (_viewId: string, _patch: unknown) => {});
let onClose = vi.fn();

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
  onClose = vi.fn();
  useWorkspace.setState({
    columns: [TITLE, STATUS],
    updateView: updateView as unknown as (
      viewId: string,
      patch: unknown,
    ) => Promise<void>,
  });
});

afterEach(cleanup);

describe("AggregateConfigPanel", () => {
  it("adds a group and saves the complete aggregate config", async () => {
    const user = userEvent.setup();
    render(<AggregateConfigPanel view={VIEW} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: /添加分组/ }));
    await user.click(screen.getByRole("button", { name: "保存并应用" }));

    expect(updateView).toHaveBeenCalledTimes(1);
    const [viewId, patch] = updateView.mock.calls[0];
    expect(viewId).toBe("va");
    const data = (patch as { data: unknown }).data as {
      kind: string;
      aggregate: { group_by: string[]; metrics: unknown[] };
    };
    expect(data.kind).toBe("grid");
    expect(data.aggregate.group_by).toEqual(["c1"]);
    expect(data.aggregate.metrics).toEqual([{ op: "count_rows", column_id: null }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("blocks saving a duplicate group", async () => {
    const user = userEvent.setup();
    useWorkspace.setState({ columns: [TITLE] });
    render(
      <AggregateConfigPanel
        view={{
          ...VIEW,
          data: {
            kind: "grid",
            filters: null,
            sorts: [],
            aggregate: {
              group_by: ["c1"],
              metrics: [{ op: "count_rows", column_id: null }],
              sort: null,
            },
          },
        }}
        onClose={onClose}
      />,
    );

    // There is only one remaining groupable column, so a second slot cannot
    // be added; the button is disabled rather than producing an invalid draft.
    const addGroup = screen.getByRole("button", { name: /添加分组/ });
    expect((addGroup as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "保存并应用" }));

    expect(updateView).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});