// @vitest-environment jsdom
//
// The CSV import dialog must show the first record as editable headers and
// pass the (possibly edited) names + types to the store exactly once.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const importCsv = vi.fn();

vi.mock("../stores/workspace", () => ({
  useWorkspace: (selector: (s: { importCsv: typeof importCsv }) => unknown) =>
    selector({ importCsv }),
}));

vi.mock("../ipc", () => ({ csvPreview: vi.fn() }));

import * as ipc from "../ipc";
import type { CsvPreview, ImportReport } from "../types";
import ImportCsvDialog from "./ImportCsvDialog";

const PREVIEW: CsvPreview = {
  first_row: ["名称", "数量"],
  rows: [["苹果", "3"]],
  total_rows: 2,
  width: 2,
  delimiter: ",",
  encoding: "utf-8",
  ragged: false,
  suggested_types: ["text", "number"],
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
  vi.mocked(ipc.csvPreview).mockResolvedValue(PREVIEW);
});

afterEach(() => cleanup());

describe("ImportCsvDialog", () => {
  it("uses the first row as editable headers and imports them", async () => {
    const user = userEvent.setup();
    const report: ImportReport = {
      table: {
        id: "t1",
        name: "水果",
        sql_name: "t_x",
        title_col_id: "c1",
        icon: null,
        color: null,
        position: 0,
        created_at: "",
        updated_at: "",
      },
      imported: 1,
      invalid_cells: 0,
    };
    importCsv.mockResolvedValue(report);

    render(<ImportCsvDialog path="/tmp/水果.csv" onClose={() => {}} />);

    // First row values appear as editable header inputs.
    const nameInput = await screen.findByDisplayValue("名称");
    expect(screen.getByDisplayValue("数量")).toBeTruthy();
    expect(screen.getByText("苹果")).toBeTruthy();

    await user.clear(nameInput);
    await user.type(nameInput, "水果名称");
    await user.click(screen.getByRole("button", { name: "导入" }));

    await waitFor(() =>
      expect(importCsv).toHaveBeenCalledWith({
        path: "/tmp/水果.csv",
        table_name: "水果",
        use_header: true,
        headers: ["水果名称", "数量"],
        types: ["text", "number"],
      }),
    );
    expect(await screen.findByText(/已导入 1 行到「水果」/)).toBeTruthy();
  });

  it("generates column names when the first row is data", async () => {
    const user = userEvent.setup();
    importCsv.mockResolvedValue(null);

    render(<ImportCsvDialog path="/tmp/raw.csv" onClose={() => {}} />);
    await screen.findByDisplayValue("名称");

    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByDisplayValue("列 1")).toBeTruthy();
    expect(screen.getByDisplayValue("列 2")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "导入" }));
    await waitFor(() =>
      expect(importCsv).toHaveBeenCalledWith(
        expect.objectContaining({
          use_header: false,
          headers: ["列 1", "列 2"],
        }),
      ),
    );
  });
});