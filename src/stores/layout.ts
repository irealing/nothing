// Sidebar layout preference. Appearance-only, so it lives in localStorage
// instead of the encrypted workspace (same rule as the theme preference).

import { create } from "zustand";

const STORAGE_KEY = "nothing.layout.sidebar";

function readCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

interface LayoutState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useLayout = create<LayoutState>((set) => ({
  sidebarCollapsed: readCollapsed(),
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "collapsed" : "expanded");
      } catch {
        // Ignore storage failures; the toggle still works for this session.
      }
      return { sidebarCollapsed: next };
    }),
}));