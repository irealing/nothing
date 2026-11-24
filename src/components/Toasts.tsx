// Toast host: renders the transient feedback stack (errors + confirmations).
//
// Each toast owns its timer so a long link can pause it on hover and several
// messages (e.g. an error right after a success) can coexist. Clicking one
// dismisses it early.

import { useEffect, useState } from "react";
import { useToasts, type ToastItem, type ToastKind } from "../stores/toast";
import { IconAlert, IconCheck } from "./icons";
import { t } from "../i18n";

/** How long a toast stays up (ms), per kind. Hover pauses the countdown. */
const DURATION: Record<ToastKind, number> = {
  error: 7000,
  success: 3200,
  info: 4200,
};

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (hovered) return;
    const timer = setTimeout(() => dismiss(item.id), DURATION[item.kind]);
    return () => clearTimeout(timer);
  }, [hovered, item.id, item.kind, dismiss]);

  return (
    <div
      className={`toast ${item.kind}`}
      role={item.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => dismiss(item.id)}
      title={t("common.clickToClose")}
    >
      <span className="toast-icon">
        {item.kind === "error" ? <IconAlert size={13} /> : <IconCheck size={13} />}
      </span>
      <span className="toast-text">{item.text}</span>
    </div>
  );
}

export default function Toasts() {
  const items = useToasts((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>
  );
}