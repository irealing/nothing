// Floating affordance for the hovered grid cell. Glide paints cells on a
// canvas, so a DOM overlay is the only way to get a real transition plus a
// clickable copy button. It is positioned in grid coordinates and rendered as a
// sibling of the canvas inside `.grid-wrap`.

import { useEffect, useRef, useState } from "react";
import { toast } from "../stores/toast";
import { t } from "../i18n";
import { IconCheck, IconCopy } from "./icons";

const CHECK_MS = 900;
/** Below this width the button would cover most of the cell's content. */
const MIN_COPY_WIDTH = 48;

export interface HoverBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Glide hands out cell bounds relative to the viewport (its `getBoundsForItem`
 * adds the canvas `getBoundingClientRect()` origin), while the overlay is
 * absolutely positioned inside `.grid-wrap`. Rebase them onto that container or
 * the overlay lands wherever the grid happens to be on the page. */
export function toLocalBounds(
  bounds: HoverBounds,
  container: { left: number; top: number },
): HoverBounds {
  return {
    ...bounds,
    x: bounds.x - container.left,
    y: bounds.y - container.top,
  };
}

export default function CellHover({
  bounds,
  copyText,
}: {
  bounds: HoverBounds;
  copyText: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (copyText === "") return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, CHECK_MS);
    } catch {
      toast.error(t("toasts.copyFailed"));
    }
  };

  const showButton = copyText !== "" && bounds.width >= MIN_COPY_WIDTH;

  return (
    <div
      className="cell-hover"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
    >
      {showButton && (
        <button
          type="button"
          className={copied ? "cell-hover-copy copied" : "cell-hover-copy"}
          aria-label={copied ? t("table.copied") : t("table.copyCell")}
          title={copied ? t("table.copied") : t("table.copyCell")}
          // Keep the canvas focused so the selection ring does not disappear
          // while the user copies a value.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void copy();
          }}
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </button>
      )}
    </div>
  );
}