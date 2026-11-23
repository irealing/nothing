// Floating single-cell editor for text / number / date columns.
//
// Glide's built-in overlay editor cannot be used with CJK input methods: its
// "type to edit" hook only reacts to ASCII keys and its keydown handler treats
// the Enter that confirms an IME composition as "commit + close" (upstream
// issues #1175 / streamlit#16129). We therefore render our own <input> on top
// of the cell — a real input element gives the IME a proper composition target.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ColumnMeta, Json } from "../types";
import { colType } from "../types";
import type { Anchor } from "./CellEditors";
import { t } from "../i18n";

export interface InlineEditorRequest {
  col: ColumnMeta;
  rowIdx: number;
  rid: string;
  anchor: Anchor;
  value: Json;
}

/** Text shown in the editor for a cell value. Exported for unit tests. */
export function textForEditor(col: ColumnMeta, value: Json): string {
  if (value === null || value === undefined) return "";
  if (colType(col) === "date" && typeof value === "string") return value.slice(0, 10);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Translate the input text back into a JSON cell value. Invalid numbers are
 * rejected (`undefined`) so the edit is simply discarded. Exported for tests. */
export function valueFromEditor(col: ColumnMeta, text: string): Json | undefined {
  if (colType(col) === "number") {
    const t = text.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isNaN(n) ? undefined : n;
  }
  if (colType(col) === "date") {
    const t = text.trim();
    return t === "" ? null : t;
  }
  return text === "" ? null : text;
}

export function InlineCellEditor({
  request,
  onCommit,
  onClose,
  onMove,
}: {
  request: InlineEditorRequest;
  onCommit: (value: Json) => void;
  onClose: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const { col, anchor, value } = request;
  const original = textForEditor(col, value);
  const [text, setText] = useState(original);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against double commits (Enter → close → outside mousedown).
  const done = useRef(false);
  const commitRef = useRef<() => void>(() => {});

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
    // Glide focuses its canvas right after the click that opened us; take the
    // focus back on the next frame so the IME composes into this input.
    const raf = requestAnimationFrame(() => {
      if (document.activeElement !== el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Commit when the pointer goes down outside the editor. Using mousedown
  // instead of blur keeps focus races from closing the editor spuriously.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = inputRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        commitRef.current();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  const commit = (move?: -1 | 1) => {
    finish(() => {
      const unchanged = text === original;
      if (!unchanged) {
        const next = valueFromEditor(col, text);
        if (next !== undefined) onCommit(next);
      }
      if (move) onMove(move);
      else onClose();
    });
  };
  commitRef.current = commit;

  const cancel = () => finish(onClose);

  const width = Math.min(Math.max(anchor.width, 160), window.innerWidth - 16);
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - width - 10));
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 46));
  const style: CSSProperties = { position: "fixed", left, top, width, zIndex: 320 };

  return (
    <input
      ref={inputRef}
      className="cell-editor"
      style={style}
      type={colType(col) === "number" ? "number" : colType(col) === "date" ? "date" : "text"}
      step={colType(col) === "number" ? "any" : undefined}
      inputMode={colType(col) === "number" ? "decimal" : undefined}
      value={text}
      placeholder={
        colType(col) === "number"
          ? t("cell.numberPlaceholder")
          : colType(col) === "date"
            ? t("cell.datePlaceholder")
            : t("cell.inputPlaceholder")
      }
      onChange={(e) => setText(e.target.value)}
      // Keep glide's window-level mousedown away from clicks inside the editor.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Never swallow keys while an IME composition is in flight.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        } else if (e.key === "Tab") {
          e.preventDefault();
          commit(e.shiftKey ? -1 : 1);
        }
      }}
    />
  );
}