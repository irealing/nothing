// Appearance controls: colour mode (light / dark / system). Used in the
// sidebar and on the welcome screen (appearance is a preference, not workspace
// state).

import { useTheme, type ThemePreference } from "../stores/theme";
import { t } from "../i18n";
import { IconMonitor, IconMoon, IconSun } from "../components/icons";

export function ThemeSwitch({ compact }: { compact?: boolean }) {
  const preference = useTheme((s) => s.preference);
  const setPreference = useTheme((s) => s.setPreference);

  const options: { value: ThemePreference; label: string; icon: typeof IconSun }[] = [
    { value: "light", label: t("sidebar.themeLight"), icon: IconSun },
    { value: "dark", label: t("sidebar.themeDark"), icon: IconMoon },
    { value: "system", label: t("sidebar.themeSystem"), icon: IconMonitor },
  ];

  return (
    <div
      className={compact ? "theme-switch compact" : "theme-switch"}
      role="radiogroup"
      aria-label={t("sidebar.theme")}
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={preference === opt.value}
            aria-label={opt.label}
            title={opt.label}
            className="theme-switch-btn"
            onClick={() => setPreference(opt.value)}
          >
            <Icon size={compact ? 13 : 14} />
          </button>
        );
      })}
    </div>
  );
}