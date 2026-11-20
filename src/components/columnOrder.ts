import type { ColumnMeta } from "../types";

/**
 * Map a Glide column-move (indices into the *visible* columns) onto the full
 * column list that `updateColumn({ position })` expects.
 *
 * `reorder` removes the column first and inserts it before the column that
 * currently occupies the drop slot, so the full-list index of that target
 * column is the right `position`. Returns null for no-ops and for the trailing
 * synthetic "add column" cell.
 */
export function movedColumnPosition(
  visible: Pick<ColumnMeta, "id">[],
  all: Pick<ColumnMeta, "id">[],
  startIndex: number,
  endIndex: number,
): { id: string; position: number } | null {
  if (startIndex < 0 || startIndex >= visible.length) return null;
  const clamped = Math.min(endIndex, visible.length - 1);
  if (clamped < 0 || clamped === startIndex) return null;
  const moved = visible[startIndex];
  const target = visible[clamped];
  if (!moved || !target) return null;
  const position = all.findIndex((c) => c.id === target.id);
  return position >= 0 ? { id: moved.id, position } : null;
}