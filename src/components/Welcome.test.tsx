// @vitest-environment jsdom
//
// The welcome screen must collapse to a password-only "unlock" card when a
// workspace is already known (last opened file / file association), and must
// fall back to the full picker on demand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../ipc");

import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import Welcome from "./Welcome";

const LAST = {
  path: "D:\\data\\工作.nothing",
  opened_at: "2026-01-01T00:00:00Z",
  exists: true,
};
const GONE = {
  path: "D:\\data\\旧.nothing",
  opened_at: "2025-12-01T00:00:00Z",
  exists: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspace.setState({
    info: null,
    tables: [],
    activeTableId: null,
    columns: [],
    visibleColumns: [],
    views: [],
    activeViewId: null,
    lastWorkspace: LAST,
    recent: [LAST, GONE],
    pendingPath: null,
    booted: true,
    error: null,
    loading: false,
  });
});

afterEach(cleanup);

describe("Welcome unlock mode", () => {
  it("asks only for the password of the remembered workspace", async () => {
    vi.mocked(ipc.workspaceOpen).mockResolvedValue({ path: LAST.path, format_version: 2 });
    vi.mocked(ipc.tableList).mockResolvedValue([]);

    render(<Welcome />);

    expect(screen.getByText("工作.nothing")).toBeTruthy();
    // The picker tabs stay hidden until the user asks for another file.
    expect(screen.queryByText("新建工作区")).toBeNull();

    await userEvent.type(screen.getByPlaceholderText("SQLCipher 密码"), "pw123{Enter}");

    await waitFor(() =>
      expect(ipc.workspaceOpen).toHaveBeenCalledWith(LAST.path, "pw123"),
    );
    expect(useWorkspace.getState().pendingPath).toBeNull();
  });

  it("lists the other recent files and marks missing ones as disabled", () => {
    render(<Welcome />);

    const gone = screen.getByText("旧.nothing").closest("button");
    expect(gone?.disabled).toBe(true);
    // The workspace being unlocked is not repeated in the recent list.
    expect(screen.queryByText("工作.nothing", { selector: ".recent-name" })).toBeNull();
  });

  it("reveals the full picker from '打开其他文件'", async () => {
    useWorkspace.setState({ pendingPath: "D:\\data\\另一个.nothing" });
    render(<Welcome />);

    expect(screen.getByText("另一个.nothing")).toBeTruthy();
    await userEvent.click(screen.getByText("打开其他文件"));

    expect(screen.getByText("新建工作区")).toBeTruthy();
    expect(useWorkspace.getState().pendingPath).toBeNull();
  });

  it("falls back to the picker when the last workspace file is gone", () => {
    useWorkspace.setState({ lastWorkspace: GONE, recent: [GONE] });
    render(<Welcome />);

    expect(screen.getByText(/上次打开的工作区已不可用/)).toBeTruthy();
    expect(screen.getByText("打开工作区", { selector: ".tab" })).toBeTruthy();
  });
});