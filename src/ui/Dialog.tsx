// Modal shell built on Radix Dialog: focus trap, Esc, outside-click, focus
// restoration and `aria-*` come from the primitive; the look stays 100% ours.
//
// Rule (AGENTS.md): overlays go through `src/ui/`, never hand-rolled.

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { IconX } from "../components/icons";
import { t } from "../i18n";

/** Shared portal/overlay plumbing for both dialog shapes. */
function Shell({
  onClose,
  layerClass,
  contentClass,
  children,
}: {
  onClose: () => void;
  layerClass: string;
  contentClass: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-backdrop" />
        <div className={layerClass}>
          <DialogPrimitive.Content className={contentClass}>{children}</DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Dialog({
  title,
  subtitle,
  onClose,
  wide,
  xwide,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  /** Extra-wide panel for data-heavy dialogs (CSV import). */
  xwide?: boolean;
  children: ReactNode;
}) {
  const contentClass = xwide ? "modal modal-xwide" : wide ? "modal modal-wide" : "modal";
  return (
    <Shell onClose={onClose} layerClass="modal-layer" contentClass={contentClass}>
      <div className="modal-head">
        <div className="modal-heading">
          <DialogPrimitive.Title asChild>
            <h3>{title}</h3>
          </DialogPrimitive.Title>
          {subtitle ? (
            <DialogPrimitive.Description asChild>
              <p className="modal-sub">{subtitle}</p>
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only" />
          )}
        </div>
        <DialogPrimitive.Close asChild>
          <button className="btn-icon" aria-label={t("common.close")}>
            <IconX />
          </button>
        </DialogPrimitive.Close>
      </div>
      <div className="modal-body">{children}</div>
    </Shell>
  );
}

/**
 * Large centred panel (filters/sorts). Same primitive guarantees as Dialog,
 * different chrome: header / scrollable body / footer.
 */
export function PanelDialog({
  title,
  badge,
  onClose,
  footer,
  side,
  children,
}: {
  title: ReactNode;
  badge?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  /** Slide-in side drawer instead of the centred panel. */
  side?: boolean;
  children: ReactNode;
}) {
  return (
    <Shell
      onClose={onClose}
      layerClass={side ? "panel-layer side-layer" : "panel-layer"}
      contentClass={side ? "panel panel-side" : "panel"}
    >
      <div className="panel-head">
        <h3>
          {title}
          {badge}
        </h3>
        <DialogPrimitive.Close asChild>
          <button className="btn-icon" aria-label={t("common.close")}>
            <IconX />
          </button>
        </DialogPrimitive.Close>
      </div>
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      <DialogPrimitive.Description className="sr-only">{t("filter.title")}</DialogPrimitive.Description>
      <div className="panel-body">{children}</div>
      {footer && <div className="panel-foot">{footer}</div>}
    </Shell>
  );
}