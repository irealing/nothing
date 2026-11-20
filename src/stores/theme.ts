// Theme preference: light / dark / follow system.
//
// The preference is *appearance*, not workspace data, so it lives in
// localStorage instead of the encrypted database (which would need a format
// migration — see AGENTS.md).

import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "nothing.theme";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // storage unavailable (private mode) — fall through
  }
  return "system";
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/** Apply the resolved theme to the document (CSS token swap). */
function applyResolved(theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const initialPreference = readPreference();
applyResolved(resolveTheme(initialPreference));

export const useTheme = create<ThemeState>((set) => ({
  preference: initialPreference,
  resolved: resolveTheme(initialPreference),
  setPreference: (preference) => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // ignore: preference simply won't persist
    }
    const resolved = resolveTheme(preference);
    applyResolved(resolved);
    set({ preference, resolved });
  },
}));

// Keep "system" in sync while the OS switches appearance.
if (typeof window !== "undefined" && window.matchMedia) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const state = useTheme.getState();
    if (state.preference !== "system") return;
    const resolved = systemTheme();
    applyResolved(resolved);
    useTheme.setState({ resolved });
  };
  if (media.addEventListener) media.addEventListener("change", onChange);
  else media.addListener(onChange);
}