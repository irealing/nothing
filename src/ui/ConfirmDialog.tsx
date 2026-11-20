// Promise-based confirmation dialog (replaces `window.confirm`, which blocks
// the webview and cannot be themed or localized).

import { create } from "zustand";
import { Dialog } from "./Dialog";
import { t } from "../i18n";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmState {
  request: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  ask: (options: ConfirmOptions) => Promise<boolean>;
  answer: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  ask: (options) =>
    new Promise<boolean>((resolve) => {
      // Only one confirmation can be pending; an older one is cancelled.
      get().request?.resolve(false);
      set({ request: { ...options, resolve } });
    }),
  answer: (ok) => {
    const pending = get().request;
    set({ request: null });
    pending?.resolve(ok);
  },
}));

/** `const ok = await confirm({ title: "…" })` */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(options);
}

/** Rendered once by App. */
export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const answer = useConfirmStore((s) => s.answer);
  if (!request) return null;
  return (
    <Dialog title={request.title} subtitle={request.description} onClose={() => answer(false)}>
      <div className="modal-actions">
        <div className="toolbar-spacer" />
        <button type="button" className="btn" onClick={() => answer(false)}>
          {request.cancelLabel ?? t("common.cancel")}
        </button>
        <button
          type="button"
          className={request.danger ? "btn danger-solid" : "btn primary"}
          onClick={() => answer(true)}
          autoFocus
        >
          {request.confirmLabel ?? t("common.confirm")}
        </button>
      </div>
    </Dialog>
  );
}