// Column presentation pickers: a curated emoji set (with recents) and the
// nine palette swatches. Both are presentation-only, so both can be cleared.

import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { ColumnColor } from "../types";
import { TAG_COLORS, tagChipStyle } from "../theme/grid";
import { IconCheck, IconX } from "../components/icons";
import { t } from "../i18n";

export const EMOJI_CHOICES = [
  "📝", "✅", "🔥", "⭐", "📌", "📅", "⏰", "🎯",
  "💡", "🚀", "🐛", "🛠️", "📊", "📈", "📉", "🧮",
  "💰", "🏷️", "🔖", "📦", "🗂️", "📁", "🔗", "🧩",
  "👤", "👥", "🏢", "🌍", "🏠", "❤️", "👍", "👀",
  "⚡", "🌱", "🍀", "☀️", "🌙", "☁️", "🎨", "🖌️",
  "🔒", "🔑", "🛡️", "⚙️", "🔍", "🔔", "✉️", "💬",
  "📣", "🧠", "🥇", "🎉", "🍎", "☕", "🧪", "🧭",
  "⏱️", "🔄", "➕", "➖", "✔️", "✖️", "❓", "❗",
];

const RECENTS_KEY = "nothing.columnIcons";

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function pushRecent(icon: string) {
  try {
    const next = [icon, ...readRecents().filter((x) => x !== icon)].slice(0, 8);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

export function EmojiPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(readRecents);
  const pick = (icon: string) => {
    pushRecent(icon);
    setRecents(readRecents());
    onChange(icon);
    setOpen(false);
  };
  return (
    <div className="ui-emoji-field">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className="ui-emoji-trigger" aria-label={t("column.icon")}>
            {value ? <span className="ui-emoji-current">{value}</span> : <span className="ui-emoji-empty">＋</span>}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="ui-popover ui-emoji-popover" sideOffset={6} align="start">
            {recents.length > 0 && (
              <>
                <div className="ui-menu-label">{t("column.recentIcons")}</div>
                <div className="ui-emoji-grid">
                  {recents.map((e) => (
                    <button key={`r-${e}`} type="button" className="ui-emoji" onClick={() => pick(e)}>
                      {e}
                    </button>
                  ))}
                </div>
                <div className="ui-menu-label">{t("column.commonIcons")}</div>
              </>
            )}
            <div className="ui-emoji-grid">
              {EMOJI_CHOICES.map((e) => (
                <button key={e} type="button" className="ui-emoji" onClick={() => pick(e)}>
                  {e}
                </button>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {value && (
        <button
          type="button"
          className="btn-icon"
          title={t("column.clearIcon")}
          onClick={() => onChange(null)}
        >
          <IconX size={12} />
        </button>
      )}
    </div>
  );
}

export function ColorSwatches({
  value,
  onChange,
}: {
  value: ColumnColor | null;
  onChange: (color: ColumnColor | null) => void;
}) {
  return (
    <div className="ui-swatches" role="radiogroup" aria-label={t("column.color")}>
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label={t("column.noColor")}
        className="ui-swatch none"
        onClick={() => onChange(null)}
      >
        <IconX size={11} />
      </button>
      {TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          className="ui-swatch"
          style={tagChipStyle(color)}
          onClick={() => onChange(color)}
        >
          {value === color && <IconCheck size={11} />}
        </button>
      ))}
    </div>
  );
}