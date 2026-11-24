import { beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_LIMIT, useHistory } from "./history";

const entry = (id: string, log: string[]) => ({
  tableId: "t1",
  label: "edit" as const,
  undo: async () => {
    log.push(`undo:${id}`);
  },
  redo: async () => {
    log.push(`redo:${id}`);
  },
});

describe("history", () => {
  beforeEach(() => {
    useHistory.getState().clear();
  });

  it("undoes and redoes in LIFO order", async () => {
    const log: string[] = [];
    const { push, undo, redo } = useHistory.getState();
    push(entry("a", log));
    push(entry("b", log));

    await undo();
    expect(log).toEqual(["undo:b"]);
    await undo();
    expect(log).toEqual(["undo:b", "undo:a"]);
    await expect(useHistory.getState().undo()).resolves.toBeNull();

    await redo();
    expect(log).toEqual(["undo:b", "undo:a", "redo:a"]);
    await redo();
    expect(log).toEqual(["undo:b", "undo:a", "redo:a", "redo:b"]);
  });

  it("drops the redo branch when a new action is pushed", async () => {
    const log: string[] = [];
    const { push, undo } = useHistory.getState();
    push(entry("a", log));
    await undo();
    expect(useHistory.getState().future).toHaveLength(1);

    push(entry("b", log));
    expect(useHistory.getState().future).toHaveLength(0);
  });

  it("keeps the entry when undo fails", async () => {
    const failing = {
      tableId: "t1",
      label: "delete" as const,
      undo: vi.fn(async () => {
        throw new Error("boom");
      }),
      redo: async () => {},
    };
    useHistory.getState().push(failing);
    await expect(useHistory.getState().undo()).rejects.toThrow("boom");
    expect(useHistory.getState().past).toHaveLength(1);
    expect(useHistory.getState().future).toHaveLength(0);
    expect(useHistory.getState().applying).toBe(false);
  });

  it("ignores pushes while applying an entry", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    useHistory.getState().push({
      tableId: "t1",
      label: "edit",
      undo: async () => {
        await gate;
      },
      redo: async () => {},
    });
    const pending = useHistory.getState().undo();
    // A nested write during undo must not create a new history entry.
    useHistory.getState().push(entry("nested", []));
    expect(useHistory.getState().past).toHaveLength(1);
    release();
    await pending;
    expect(useHistory.getState().past).toHaveLength(0);
  });

  it("caps the stack at HISTORY_LIMIT", () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      useHistory.getState().push(entry(String(i), []));
    }
    expect(useHistory.getState().past).toHaveLength(HISTORY_LIMIT);
    expect(useHistory.getState().past[0].undo).toBeTypeOf("function");
  });
});