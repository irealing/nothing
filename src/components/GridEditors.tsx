// Floating single-cell editor for text / number / date columns.
//
// Glide's built-in overlay editor cannot be used with CJK input methods: its
// "type to edit" hook only reacts to ASCII keys and its keydown handler treats
// the Enter that confirms an IME composition as "commit + close" (upstream
// issues #1175 / streamlit#16129). We therefore render our own <input> on top
// of the cell — a real input element gives the IME a proper composition target.
//
// Two IME landmines are guarded here:
//
// 1. Chromium fires `compositionend` *before* the `keydown` of the keystroke
//    that confirmed the candidate, and `isComposing` is already false by then.
//    Committing on that keydown writes the un-composed pinyin buffer.
// 2. Chromium dispatches `scroll` on the <input> itself when its text scrolls
//    (a long pinyin buffer wider than the cell). A window-level capture
//    listener sees it and would end the edit in the middle of a composition.
//
// The value is therefore read from the DOM at commit time (never from React
// state, which lags the IME), and nothing commits while a composition is live.

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { ColumnMeta, Json } from "../types";
import { colType } from "../types";
import type { Anchor } from "./CellEditors";
import { t } from "../i18n";

/** Tab moves sideways and keeps editing; Enter closes and moves the selection. */
export type EditorMove = -1 | 1 | "down" | "up";

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
 * rejected (`undefined`) so the editor can flag the input instead of writing
 * garbage. Exported for tests. */
export function valueFromEditor(col: ColumnMeta, text: string): Json | undefined {
  if (colType(col) === "number") {
    const t = text.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  if (colType(col) === "date") {
    const t = text.trim();
    return t === "" ? null : t;
  }
  return text === "" ? null : text;
}

/** Scroll only counts once the editor has settled (opening it may auto-scroll). */
const SCROLL_GRACE_MS = 150;

/** Keystrokes this soon after `compositionend` still belong to the IME. */
const COMPOSITION_GRACE_MS = 80;

export function InlineCellEditor({
  request,
  onCommit,
  onClose,
  onMove,
  scrollHost,
}: {
  request: InlineEditorRequest;
  onCommit: (value: Json) => void;
  onClose: () => void;
  onMove: (dir: EditorMove) => void;
  /** The grid container. Scroll events outside it (including the editor's own
   * internal scroll) must never end the edit. */
  scrollHost?: RefObject<HTMLElement | null>;
}) {
  const { col, anchor, value } = request;
  const original = textForEditor(col, value);
  // The input is uncontrolled: React must never write into it while the IME
  // owns the composition, and commit reads exactly what the user sees.
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against double commits (Enter → close → outside mousedown).
  const done = useRef(false);
  const commitRef = useRef<(move?: EditorMove) => void>(() => {});
  const composing = useRef(false);
  const compositionEndedAt = useRef(Number.NEGATIVE_INFINITY);

  /** True while the IME owns the input, including the confirming keystroke. */
  const composingNow = () =>
    composing.current ||
    performance.now() - compositionEndedAt.current < COMPOSITION_GRACE_MS;

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
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      if (done.current) return;
      // An invalid value must not trap the user: discard it on outside click.
      const text = el.value;
      if (valueFromEditor(col, text) === undefined && text !== original) {
        done.current = true;
        onClose();
        return;
      }
      commitRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [col, original, onClose]);

  // Scrolling the grid would leave the fixed-position editor floating over a
  // different cell, so a grid scroll commits the edit and closes. Only scrolls
  // *inside the grid* count: Chromium also fires `scroll` on the editor input
  // itself while its text overflows, and on every other pane of the app.
  useEffect(() => {
    let armed = false;
    const arm = window.setTimeout(() => {
      armed = true;
    }, SCROLL_GRACE_MS);
    const onScroll = (e: Event) => {
      if (!armed) return;
      const host = scrollHost?.current;
      if (!host || !(e.target instanceof Node) || !host.contains(e.target)) return;
      commitRef.current();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimeout(arm);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [scrollHost]);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  const commit = (move?: EditorMove) => {
    if (done.current) return;
    if (composing.current) {
      // A scroll or outside click landed mid-composition: the buffer is not a
      // value yet. Close without persisting the pinyin.
      done.current = true;
      onClose();
      return;
    }
    const text = inputRef.current?.value ?? original;
    if (text !== original) {
      const next = valueFromEditor(col, text);
      if (next === undefined) {
        // Keep the editor open and flag it: silently dropping an edit is how
        // "my number vanished" bugs feel.
        setInvalid(true);
        inputRef.current?.select();
        return;
      }
      done.current = true;
      onCommit(next);
      if (move) onMove(move);
      else onClose();
      return;
    }
    done.current = true;
    if (move) onMove(move);
    else onClose();
  };
  commitRef.current = commit;

  const cancel = () => finish(onClose);

  // Cover the cell exactly: a wider/taller editor would leave a sliver of the
  // grid's selection highlight showing around it, which reads as a second
  // frame next to the editor border.
  const width = Math.max(24, Math.min(anchor.width, window.innerWidth - 16));
  const height = Math.max(24, Math.min(anchor.height, window.innerHeight - 16));
  const left = Math.max(0, Math.min(anchor.x, window.innerWidth - width));
  const top = Math.max(0, Math.min(anchor.y, window.innerHeight - height));
  const style: CSSProperties = { position: "fixed", left, top, width, height, zIndex: 320 };

  return (
    <input
      ref={inputRef}
      className={invalid ? "cell-editor invalid" : "cell-editor"}
      style={style}
      type={colType(col) === "number" ? "number" : colType(col) === "date" ? "date" : "text"}
      step={colType(col) === "number" ? "any" : undefined}
      inputMode={colType(col) === "number" ? "decimal" : undefined}
      defaultValue={original}
      aria-invalid={invalid || undefined}
      placeholder={
        colType(col) === "number"
          ? t("cell.numberPlaceholder")
          : colType(col) === "date"
            ? t("cell.datePlaceholder")
            : t("cell.inputPlaceholder")
      }
      onChange={() => {
        if (invalid) setInvalid(false);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        compositionEndedAt.current = performance.now();
      }}
      // A stray focus grab (the grid taking control back, a popup opening) must
      // not leave a half-edited cell behind; a window switch must not commit.
      onBlur={(e) => {
        if (done.current || !document.hasFocus()) return;
        if (composing.current) {
          inputRef.current?.focus();
          return;
        }
        // Only another real element taking focus is "the user left". Browser
        // internals (date picker, IME) report no related target and must keep
        // the editor alive.
        const next = e.relatedTarget;
        if (next instanceof Node && document.contains(next)) commitRef.current();
      }}
      // Keep glide's window-level mousedown away from clicks inside the editor.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Never swallow keys while an IME composition is in flight — including
        // the keystroke that confirmed the candidate, which Chromium delivers
        // after `compositionend` with `isComposing` already false.
        if (e.nativeEvent.isComposing || e.keyCode === 229 || composingNow()) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.shiftKey ? "up" : "down");
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
