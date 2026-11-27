// @vitest-environment jsdom
//
// Behaviour of the floating cell editor around IME composition. These cases
// pin the two regressions that made CJK editing lose focus and write the raw
// pinyin buffer into the cell:
//
//   1. Chromium fires `scroll` on the <input> itself while its text overflows,
//      and a window-level capture listener used to treat that as "the grid
//      scrolled" → commit mid-composition.
//   2. Chromium fires `compositionend` before the keydown of the confirming
//      keystroke, with `isComposing` already false → Enter committed the pinyin.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ColumnMeta, ColumnType } from "../types";
import { InlineCellEditor, type InlineEditorRequest } from "./GridEditors";

function col(type: ColumnType = "text"): ColumnMeta {
  const sql_name = "c_x";
  const data =
    type === "number"
      ? ({ kind: "number", sql_name } as const)
      : type === "date"
        ? ({ kind: "date", sql_name } as const)
        : ({ kind: "text", sql_name } as const);
  return {
    id: "c1",
    table_id: "t1",
    name: type,
    position: 0,
    width: 160,
    icon: null,
    color: null,
    align: null,
    default_value: null,
    format: null,
    created_at: "",
    data,
  };
}

/** Past the scroll grace period so scroll events are actually considered. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 180));

function renderEditor(options: { type?: ColumnType; value?: InlineEditorRequest["value"] } = {}) {
  const onCommit = vi.fn();
  const onClose = vi.fn();
  const onMove = vi.fn();
  // Mirrors `TableView`: the editor is a sibling of the grid wrapper, so the
  // input itself is never inside the scroll host.
  const host = document.createElement("div");
  const scroller = document.createElement("div");
  host.appendChild(scroller);
  document.body.appendChild(host);
  const request: InlineEditorRequest = {
    col: col(options.type ?? "text"),
    rowIdx: 0,
    rid: "r1",
    anchor: { x: 10, y: 10, width: 160, height: 36 },
    value: options.value ?? null,
  };
  const { container } = render(
    <InlineCellEditor
      request={request}
      onCommit={onCommit}
      onClose={onClose}
      onMove={onMove}
      scrollHost={{ current: host }}
    />,
  );
  const input = container.querySelector("input") as HTMLInputElement;
  return { input, host, scroller, onCommit, onClose, onMove };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("InlineCellEditor composition safety", () => {
  it("ignores scroll coming from the editor's own overflowing text", async () => {
    const { input, onCommit, onClose } = renderEditor();
    await settle();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "zhonghuarenmingongheguo" } });
    // Chromium dispatches this when the pinyin buffer scrolls the input.
    fireEvent.scroll(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores scroll from panes outside the grid", async () => {
    const { input, onCommit, onClose } = renderEditor();
    await settle();

    const sidebar = document.createElement("div");
    document.body.appendChild(sidebar);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.scroll(sidebar);

    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("commits when the grid scrolls the anchored cell away", async () => {
    const { input, scroller, onCommit, onClose } = renderEditor();
    await settle();

    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.scroll(scroller);

    expect(onCommit).toHaveBeenCalledWith("你好");
    expect(onClose).toHaveBeenCalled();
  });

  it("never persists the pinyin buffer when clicking away mid-composition", () => {
    const { input, onCommit, onClose } = renderEditor();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "ni'hao" } });
    fireEvent.mouseDown(document.body);

    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("treats the Enter that confirms a candidate as part of the IME", async () => {
    const { input, onCommit, onMove } = renderEditor();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "nihao" } });
    fireEvent.compositionEnd(input);
    // Chromium delivers this keydown after compositionend (isComposing false).
    const notCancelled = fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });

    expect(notCancelled).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();

    // The committed text lands, then a later Enter finishes the edit.
    fireEvent.change(input, { target: { value: "你好" } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledWith("你好");
    expect(onMove).toHaveBeenCalledWith("down");
  });

  it("commits the value shown in the DOM, not a stale React state", () => {
    const { input, onCommit } = renderEditor({ value: "old" });

    // Uncontrolled input: React never re-renders the typed text.
    fireEvent.change(input, { target: { value: "new value" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledWith("new value");
  });

  it("closes without a write when the value did not change", () => {
    const { input, onCommit, onClose, onMove } = renderEditor({ value: "same" });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onMove).toHaveBeenCalledWith("down");
  });

  it("still commits a normal edit on an outside click", () => {
    const { input, onCommit, onClose } = renderEditor();

    fireEvent.change(input, { target: { value: "plain text" } });
    fireEvent.mouseDown(document.body);

    expect(onCommit).toHaveBeenCalledWith("plain text");
    expect(onClose).toHaveBeenCalled();
  });
});
