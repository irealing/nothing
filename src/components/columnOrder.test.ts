import { describe, expect, it } from "vitest";
import { movedColumnPosition } from "./columnOrder";

const ids = (...names: string[]) => names.map((id) => ({ id }));

describe("movedColumnPosition", () => {
  it("maps a simple move onto the visible order", () => {
    const all = ids("a", "b", "c");
    expect(movedColumnPosition(all, all, 0, 2)).toEqual({ id: "a", position: 2 });
    expect(movedColumnPosition(all, all, 2, 0)).toEqual({ id: "c", position: 0 });
  });

  it("accounts for view-hidden columns in the full list", () => {
    const visible = ids("a", "b", "c");
    const all = ids("a", "h", "b", "c");
    // Dropping "a" on the last visible slot must land after "c", not before it.
    expect(movedColumnPosition(visible, all, 0, 2)).toEqual({ id: "a", position: 3 });
  });

  it("clamps drops onto the synthetic add-column cell", () => {
    const visible = ids("a", "b", "c");
    const all = ids("a", "b", "c");
    // Glide reports endIndex = visible.length when dropped on the "+" cell.
    expect(movedColumnPosition(visible, all, 0, 3)).toEqual({ id: "a", position: 2 });
  });

  it("ignores no-ops and moves of the synthetic cell itself", () => {
    const visible = ids("a", "b");
    const all = ids("a", "b");
    expect(movedColumnPosition(visible, all, 1, 1)).toBeNull();
    expect(movedColumnPosition(visible, all, 2, 0)).toBeNull();
    expect(movedColumnPosition(visible, all, -1, 0)).toBeNull();
  });

  it("returns null when the target column is unknown", () => {
    const visible = ids("a", "b");
    expect(movedColumnPosition(visible, ids("a"), 0, 1)).toBeNull();
  });
});