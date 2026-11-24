// Workspace-wide undo/redo stack (session only).
//
// Entries are deliberately *closures* created by the workspace store: they
// capture the affected table id, the inverse values and the ipc calls, so the
// stack never needs to import the store (which would create a cycle). Structural
// operations (column type/choices changes, column/table deletion, workspace
// switch) clear the whole stack — their snapshots would no longer be valid.

import { create } from "zustand";

export type HistoryLabel = "edit" | "paste" | "insert" | "duplicate" | "delete";

export interface HistoryEntry {
  tableId: string;
  label: HistoryLabel;
  /** Apply the inverse of the recorded operation. May throw. */
  undo: () => Promise<void>;
  /** Re-apply the recorded operation (snapshots refresh inside the closure). */
  redo: () => Promise<void>;
}

/** Hard cap: deep history is not worth unbounded memory for row snapshots. */
export const HISTORY_LIMIT = 50;

interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** True while an undo/redo is running (writes must not be recorded again). */
  applying: boolean;
  push: (entry: HistoryEntry) => void;
  clear: () => void;
  undo: () => Promise<HistoryEntry | null>;
  redo: () => Promise<HistoryEntry | null>;
}

export const useHistory = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  applying: false,

  push: (entry) => {
    if (get().applying) return;
    set((s) => ({
      past: [...s.past, entry].slice(-HISTORY_LIMIT),
      // A new action invalidates the redo branch.
      future: [],
    }));
  },

  clear: () => set({ past: [], future: [] }),

  undo: async () => {
    if (get().applying) return null;
    const entry = get().past[get().past.length - 1];
    if (!entry) return null;
    set({ applying: true });
    try {
      await entry.undo();
      set((s) => ({
        past: s.past.slice(0, -1),
        future: [...s.future, entry].slice(-HISTORY_LIMIT),
      }));
      return entry;
    } finally {
      set({ applying: false });
    }
  },

  redo: async () => {
    if (get().applying) return null;
    const entry = get().future[get().future.length - 1];
    if (!entry) return null;
    set({ applying: true });
    try {
      await entry.redo();
      set((s) => ({
        future: s.future.slice(0, -1),
        past: [...s.past, entry].slice(-HISTORY_LIMIT),
      }));
      return entry;
    } finally {
      set({ applying: false });
    }
  },
}));