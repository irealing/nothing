// Transient operation feedback (errors + confirmations).
//
// Kept separate from the workspace store so any layer can report without
// threading state through the app: the store catches ipc failures here, and
// actions that finish silently (delete table/column, password change) push a
// success toast. The host component renders the stack.

import { create } from "zustand";

export type ToastKind = "error" | "success" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

/** Oldest toasts beyond this count are dropped so the stack stays readable. */
const MAX_TOASTS = 4;

let seq = 0;

interface ToastState {
  items: ToastItem[];
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: number) => void;
}

export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (kind, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((s) => {
      const last = s.items[s.items.length - 1];
      // A repeated message (e.g. retrying a failing action) refreshes the
      // stack instead of piling up identical rows.
      if (last && last.kind === kind && last.text === trimmed) return s;
      const items = [...s.items, { id: ++seq, kind, text: trimmed }];
      return { items: items.slice(-MAX_TOASTS) };
    });
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((item) => item.id !== id) })),
}));

/** Convenience helpers for call sites outside React. */
export const toast = {
  error: (text: string) => useToasts.getState().push("error", text),
  success: (text: string) => useToasts.getState().push("success", text),
  info: (text: string) => useToasts.getState().push("info", text),
};