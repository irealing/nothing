// Thin indeterminate progress bar shown while a long workspace mutation runs
// (column type migration, table rebuild, CSV import). Fast edits stay under
// the visibility delay so the bar does not flicker.

import { useEffect, useState } from "react";
import { useWorkspace } from "../stores/workspace";

/** Only show the bar if the operation outlives this (ms) — avoids flicker. */
const SHOW_DELAY = 160;

export default function TopProgress() {
  const loading = useWorkspace((s) => s.loading);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_DELAY);
    return () => clearTimeout(timer);
  }, [loading]);

  return (
    <div
      className={visible ? "top-progress active" : "top-progress"}
      role="progressbar"
      aria-hidden={!visible}
    />
  );
}