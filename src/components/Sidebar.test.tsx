// @vitest-environment jsdom
//
// The sidebar is the tree navigator: tables stay folded by default, clicking a
// table reveals its grid views, and the SQL section exposes workspace-level
// views directly.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../ipc", () => ({
  appInfo: vi.fn(),
  pickCsvFile: vi.fn(),
}));

import type { TableMeta, ViewMeta } from "../types";
import { useWorkspace } from "../stores/workspace";
import { useLayout } from "../stores/layout";
import { TooltipProvider } from "../ui/Tooltip";
import Sidebar from "./Sidebar";

function renderSidebar() {
  return render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>,
  );
}

const T1: TableMeta = {
  id: "t1",
  name: "任务",
  sql_name: "t_1",
  title_col_id: "c1",
  icon: null,
  color: null,
  position: 0,
  created_at: "",
  updated_at: "",
};

const T2: TableMeta = { ...T1, id: "t2", name: "项目", sql_name: "t_2", position: 1 };

function gridView(id: string, tableId: string, name: string): ViewMeta {
  return {
    id,
    table_id: tableId,
    name,
    kind: "grid",
    icon: null,
    color: null,
    position: 0,
    created_at: "",
    data: { kind: "grid", filters: null, sorts: [] },
    columns: [],
  };
}

const V1 = gridView("v1", "t1", "默认视图");
const V2 = gridView("v2", "t2", "项目视图");
const SQL_V: ViewMeta = {
  id: "vs",
  table_id: null,
  name: "统计",
  kind: "sql",
  icon: null,
  color: null,
  position: 0,
  created_at: "",
  data: { kind: "sql", statement: "SELECT 1" },
  columns: [],
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
  useLayout.setState({ sidebarCollapsed: false });
  useWorkspace.setState({
    info: { path: "/a.nothing", format_version: 1 },
    tables: [T1, T2],
    allViews: [V1, V2, SQL_V],
    activeTableId: "t1",
    activeViewId: "v1",
    selectTable: vi.fn().mockResolvedValue(undefined),
    selectView: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => cleanup());

describe("Sidebar view tree", () => {
  it("keeps table views folded by default", () => {
    renderSidebar();
    expect(screen.queryByText("默认视图")).toBeNull();
    expect(screen.queryByText("项目视图")).toBeNull();
  });

  it("expands a table on click and enters one of its views", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByText("项目"));

    expect(await screen.findByText("项目视图")).toBeTruthy();
    expect(useWorkspace.getState().selectTable).toHaveBeenCalledWith("t2");

    await user.click(screen.getByText("项目视图"));

    expect(useWorkspace.getState().selectTable).toHaveBeenLastCalledWith("t2", "v2");
  });

  it("lists workspace SQL views separately and opens them directly", async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(screen.getByText("SQL 视图")).toBeTruthy();
    await user.click(screen.getByText("统计"));

    expect(useWorkspace.getState().selectView).toHaveBeenCalledWith("vs");
  });
});