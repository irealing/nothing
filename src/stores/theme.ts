// Appearance preference: colour mode only (light / dark / follow system).
// It is *appearance*, not workspace data, so it lives in localStorage instead
// of the encrypted database (which would need a format migration — see
// AGENTS.md).

import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "nothing.theme";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function isPreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readPreference(): ThemePreference {
  const fallback: ThemePreference = "system";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    // Older builds stored a bare preference string.
    if (isPreference(raw)) return raw;
    // …and newer ones stored JSON that also carried a removed UI scheme.
    const parsed = JSON.parse(raw) as { preference?: unknown } | null;
    return isPreference(parsed?.preference) ? parsed.preference : fallback;
  } catch {
    // Storage unavailable (private mode) or malformed — fall back to defaults.
    return fallback;
  }
}

function persist(preference: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // ignore: preference simply won't persist
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/** Apply the resolved mode to the document (CSS token swap). */
function applyResolved(theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Radix Colors scopes its dark scales to `.dark`; keep the class in sync with
  // the `data-theme` attribute so both our tokens and the scales flip together.
  root.classList.toggle("dark", theme === "dark");
  // Older builds also set `data-scheme`; drop it so stale skins cannot linger.
  root.removeAttribute("data-scheme");
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const initial = readPreference();
applyResolved(resolveTheme(initial));

export const useTheme = create<ThemeState>((set) => ({
  preference: initial,
  resolved: resolveTheme(initial),
  setPreference: (preference) => {
    const resolved = resolveTheme(preference);
    persist(preference);
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