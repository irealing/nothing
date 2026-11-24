// Appearance preferences: colour mode (light / dark / follow system) and the
// visual scheme ("notion" is the default quiet look, "fluent" is the Windows
// 11 inspired skin). Both are *appearance*, not workspace data, so they live in
// localStorage instead of the encrypted database (which would need a format
// migration — see AGENTS.md).

import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type ThemeScheme = "notion" | "fluent";

const STORAGE_KEY = "nothing.theme";

interface StoredPrefs {
  preference: ThemePreference;
  scheme: ThemeScheme;
}

const DEFAULTS: StoredPrefs = { preference: "system", scheme: "notion" };

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function isPreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readPrefs(): StoredPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Older builds stored a bare preference string; keep reading it.
    if (isPreference(raw)) return { preference: raw, scheme: "notion" };
    const parsed = JSON.parse(raw) as Partial<StoredPrefs> | null;
    return {
      preference: isPreference(parsed?.preference) ? parsed.preference : DEFAULTS.preference,
      scheme: parsed?.scheme === "fluent" ? "fluent" : "notion",
    };
  } catch {
    // Storage unavailable (private mode) or malformed — fall back to defaults.
    return DEFAULTS;
  }
}

function persist(prefs: StoredPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore: preference simply won't persist
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/** Apply the resolved mode + scheme to the document (CSS token swap). */
function applyResolved(theme: ResolvedTheme, scheme: ThemeScheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.scheme = scheme;
  // Radix Colors scopes its dark scales to `.dark`; keep the class in sync with
  // the `data-theme` attribute so both our tokens and the scales flip together.
  root.classList.toggle("dark", theme === "dark");
}

interface ThemeState extends StoredPrefs {
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  setScheme: (scheme: ThemeScheme) => void;
}

const initial = readPrefs();
applyResolved(resolveTheme(initial.preference), initial.scheme);

export const useTheme = create<ThemeState>((set, get) => ({
  preference: initial.preference,
  scheme: initial.scheme,
  resolved: resolveTheme(initial.preference),
  setPreference: (preference) => {
    const resolved = resolveTheme(preference);
    const scheme = get().scheme;
    persist({ preference, scheme });
    applyResolved(resolved, scheme);
    set({ preference, resolved });
  },
  setScheme: (scheme) => {
    const resolved = get().resolved;
    persist({ preference: get().preference, scheme });
    applyResolved(resolved, scheme);
    set({ scheme });
  },
}));

// Keep "system" in sync while the OS switches appearance.
if (typeof window !== "undefined" && window.matchMedia) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const state = useTheme.getState();
    if (state.preference !== "system") return;
    const resolved = systemTheme();
    applyResolved(resolved, state.scheme);
    useTheme.setState({ resolved });
  };
  if (media.addEventListener) media.addEventListener("change", onChange);
  else media.addListener(onChange);
}