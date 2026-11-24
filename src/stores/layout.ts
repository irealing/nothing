// Layout preferences. Appearance-only, so they live in localStorage instead of
// the encrypted workspace (same rule as the theme preference).

import { create } from "zustand";

const SIDEBAR_KEY = "nothing.layout.sidebar";
const ROW_NUMBERS_KEY = "nothing.layout.rowNumbers";

function readCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Row numbers also provide the checkbox used to select whole rows, so they
 * stay off by default to keep the grid flush; the toolbar can reveal them. */
function readShowRowNumbers(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(ROW_NUMBERS_KEY) === "shown";
  } catch {
    return false;
  }
}

interface LayoutState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  showRowNumbers: boolean;
  toggleRowNumbers: () => void;
}

export const useLayout = create<LayoutState>((set) => ({
  sidebarCollapsed: readCollapsed(),
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
      } catch {
        // Ignore storage failures; the toggle still works for this session.
      }
      return { sidebarCollapsed: next };
    }),
  showRowNumbers: readShowRowNumbers(),
  toggleRowNumbers: () =>
    set((state) => {
      const next = !state.showRowNumbers;
      try {
        localStorage.setItem(ROW_NUMBERS_KEY, next ? "shown" : "hidden");
      } catch {
        // Ignore storage failures; the toggle still works for this session.
      }
      return { showRowNumbers: next };
    }),
}));