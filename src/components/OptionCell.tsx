// Colored option pills for select / multi_select cells.
//
// Glide's built-in Bubble cell only accepts plain strings, so per-option
// colors have to be drawn by us. The cell stays a CustomCell; click handling
// remains in TableView and still opens the normal SelectPopover.

import {
  GridCellKind,
  type CustomCell,
  type CustomRenderer,
} from "@glideapps/glide-data-grid";
import type { ColumnColor, ColumnMeta, Json } from "../types";
import { choicesOf } from "../types";
import type { ChipColors, OptionPalette } from "../theme/grid";

export interface OptionPill {
  name: string;
  icon: string | null;
  color: ColumnColor | null;
}

export interface OptionCellData {
  kind: "option-pills";
  pills: OptionPill[];
}

export type OptionCell = CustomCell<OptionCellData>;

export const PILL_HEIGHT = 22;
export const PILL_RADIUS = 6;
export const PILL_PADDING_X = 8;
export const PILL_GAP = 6;
export const CELL_PADDING_X = 10;

/** Text drawn inside a pill: icon and name with a single separating space. */
export function pillLabel(pill: OptionPill): string {
  return pill.icon ? `${pill.icon} ${pill.name}` : pill.name;
}

export interface PillLayoutItem {
  pill: OptionPill;
  label: string;
  width: number;
}

export interface OptionPillLayout {
  visible: PillLayoutItem[];
  hidden: number;
  counterLabel: string | null;
  counterWidth: number;
}

/**
 * Fit as many pills as possible into `availableWidth`, reserving room for a
 * `+N` counter when the list overflows. Pure so it can be unit-tested with a
 * fake `measure`.
 *
 * When even the first pill does not fit, it is kept at the full available
 * width and truncated by the renderer; losing the whole value behind `+1`
 * would be worse than showing an ellipsis.
 */
export function layoutOptionPills(
  pills: readonly OptionPill[],
  availableWidth: number,
  measure: (text: string) => number,
): OptionPillLayout {
  if (pills.length === 0) {
    return { visible: [], hidden: 0, counterLabel: null, counterWidth: 0 };
  }

  const items = pills.map((pill) => {
    const label = pillLabel(pill);
    return { pill, label, width: measure(label) + PILL_PADDING_X * 2 };
  });

  const total = items.reduce(
    (sum, item, i) => sum + item.width + (i > 0 ? PILL_GAP : 0),
    0,
  );
  if (total <= availableWidth) {
    return { visible: items, hidden: 0, counterLabel: null, counterWidth: 0 };
  }

  const counterWidthFor = (count: number) =>
    measure(`+${count}`) + PILL_PADDING_X * 2;

  // Reserve using the largest possible counter; the actual one is narrower.
  const budget = availableWidth - counterWidthFor(pills.length) - PILL_GAP;
  const visible: PillLayoutItem[] = [];
  let used = 0;
  for (const item of items) {
    const next = visible.length === 0 ? item.width : used + PILL_GAP + item.width;
    if (next > budget) break;
    visible.push(item);
    used = next;
  }

  // Keep the first pill visible (truncated) instead of showing only a counter.
  if (visible.length === 0) {
    visible.push({ ...items[0], width: Math.max(0, availableWidth) });
  }

  const hidden = pills.length - visible.length;
  if (hidden === 0) {
    return { visible, hidden: 0, counterLabel: null, counterWidth: 0 };
  }
  return {
    visible,
    hidden,
    counterLabel: `+${hidden}`,
    counterWidth: counterWidthFor(hidden),
  };
}

/** Build the custom cell payload for a select / multi_select value. */
export function optionCellFor(
  col: ColumnMeta,
  value: Json | undefined,
  contentAlign?: "left" | "right" | "center",
): OptionCell {
  const raw = Array.isArray(value)
    ? (value as Json[]).map(String)
    : value === null || value === undefined || value === ""
      ? []
      : [String(value)];
  const byName = new Map(choicesOf(col).map((choice) => [choice.name, choice]));
  const pills = raw.map((name): OptionPill => {
    const choice = byName.get(name);
    return {
      name,
      icon: choice?.icon ?? null,
      color: choice?.color ?? null,
    };
  });
  return {
    kind: GridCellKind.Custom,
    data: { kind: "option-pills", pills },
    copyData: raw.join(", "),
    contentAlign,
    readonly: true,
    allowOverlay: false,
  };
}

function isOptionCell(cell: CustomCell): cell is OptionCell {
  const data = cell.data as { kind?: unknown } | null | undefined;
  return cell.kind === GridCellKind.Custom && data?.kind === "option-pills";
}

function colorsFor(pill: OptionPill, palette: OptionPalette): ChipColors {
  if (!pill.color) return palette.neutral;
  return palette.resolve(pill.color);
}

export function createOptionCellRenderer(
  palette: OptionPalette,
): CustomRenderer<OptionCell> {
  return {
    kind: GridCellKind.Custom,
    isMatch: isOptionCell,
    draw: (args, cell) => {
      const { ctx, rect, theme } = args;
      const pills = cell.data.pills;
      if (pills.length === 0) return;

      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.font = `600 12px ${theme.fontFamily || "sans-serif"}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      const available = Math.max(0, rect.width - CELL_PADDING_X * 2);
      const layout = layoutOptionPills(pills, available, (text) =>
        ctx.measureText(text).width,
      );
      const y = rect.y + (rect.height - PILL_HEIGHT) / 2;
      let x = rect.x + CELL_PADDING_X;

      for (const item of layout.visible) {
        const maxText = Math.max(0, item.width - PILL_PADDING_X * 2);
        const text = truncateText(ctx, item.label, maxText);
        drawPill(ctx, x, y, item.width, text, colorsFor(item.pill, palette));
        x += item.width + PILL_GAP;
      }

      const counterRight = rect.x + rect.width - CELL_PADDING_X;
      if (
        layout.counterLabel &&
        layout.counterWidth > 0 &&
        x + layout.counterWidth <= counterRight
      ) {
        drawPill(
          ctx,
          x,
          y,
          layout.counterWidth,
          layout.counterLabel,
          palette.neutral,
        );
      }
      ctx.restore();
    },
  };
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  label: string,
  colors: ChipColors,
) {
  pathRoundRect(ctx, x, y, width, PILL_HEIGHT, PILL_RADIUS);
  ctx.fillStyle = colors.background;
  ctx.fill();
  if (colors.borderColor) {
    ctx.strokeStyle = colors.borderColor;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = colors.color;
  ctx.fillText(label, x + PILL_PADDING_X, y + PILL_HEIGHT / 2 + 1);
}

function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  const ellipsis = "…";
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join("") + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? chars.slice(0, lo).join("") + ellipsis : ellipsis;
}

function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  const maybe = ctx as CanvasRenderingContext2D & {
    roundRect?: (
      x: number,
      y: number,
      w: number,
      h: number,
      radii?: number | number[],
    ) => void;
  };
  if (typeof maybe.roundRect === "function") {
    maybe.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
