import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { t } from "../i18n";
import { formatDate } from "../i18n/format";
import { useWorkspace } from "../stores/workspace";
import type { AppInfo } from "../types";
import { Dialog } from "../ui/Dialog";

/**
 * About / build info. The version chip lives in the sidebar footer and on the
 * welcome screen, so a broken workspace still reports the exact binary before
 * anyone can open it. Build metadata never changes while the app runs, hence
 * the single module-level fetch.
 */

/** `undefined` while loading, `null` when the command failed. */
type AppInfoState = AppInfo | null | undefined;

let cached: Promise<AppInfo> | null = null;

function loadAppInfo(): Promise<AppInfo> {
  // `Promise.resolve().then` keeps the chain alive even if a test double
  // returns `undefined` instead of a promise.
  cached ??= Promise.resolve().then(() => ipc.appInfo());
  return cached;
}

export function useAppInfo(): AppInfoState {
  const [info, setInfo] = useState<AppInfoState>(undefined);
  useEffect(() => {
    let alive = true;
    loadAppInfo()
      .then((v) => {
        if (alive) setInfo(v);
      })
      .catch(() => {
        if (alive) setInfo(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** `v0.1.0-3-gc95bf81-dirty` → `c95bf81-dirty` (the chip is narrow). */
export function shortRev(git: string): string {
  const dirty = git.endsWith("-dirty");
  const base = dirty ? git.slice(0, -"-dirty".length) : git;
  const abbreviated = /(?:^|-g)([0-9a-f]{4,40})$/.exec(base);
  const rev = abbreviated ? abbreviated[1] : base;
  return dirty ? `${rev}-dirty` : rev;
}

/** Plain-text block for bug reports: stable ASCII, no UI copy to translate. */
function diagnostics(info: AppInfo, formatVersion: number | null): string {
  const lines = [
    `Nothing ${info.version}`,
    `commit ${info.git} (${info.branch})`,
    `built ${info.build_time}`,
    `platform ${info.platform} · tauri ${info.tauri_version}`,
  ];
  if (formatVersion !== null) lines.push(`format ${formatVersion}`);
  return lines.join("\n");
}

export function AboutDialog({
  info,
  onClose,
}: {
  info: AppInfoState;
  onClose: () => void;
}) {
  const formatVersion = useWorkspace((s) => s.info?.format_version ?? null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (!info || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(diagnostics(info, formatVersion));
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, 1500);
    } catch {
      // Clipboard denied: the rows stay selectable for a manual copy.
    }
  };

  return (
    <Dialog title={t("about.title")} onClose={onClose}>
      <div className="about-brand">
        <img className="brand-logo" src="/icon.png" alt="" />
        <div>
          <h4>Nothing</h4>
          <p className="brand-sub">{t("welcome.tagline")}</p>
        </div>
      </div>
      {info ? (
        <dl className="about-list">
          <dt>{t("about.version")}</dt>
          <dd>v{info.version}</dd>
          <dt>{t("about.commit")}</dt>
          <dd>{info.git}</dd>
          <dt>{t("about.branch")}</dt>
          <dd>{info.branch}</dd>
          <dt>{t("about.buildTime")}</dt>
          <dd>{formatDate(info.build_time)}</dd>
          <dt>{t("about.platform")}</dt>
          <dd>
            {info.platform} · Tauri {info.tauri_version}
          </dd>
          {formatVersion !== null && (
            <>
              <dt>{t("about.format")}</dt>
              <dd>{formatVersion}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="hint">{info === null ? t("about.unavailable") : t("about.loading")}</p>
      )}
      <div className="modal-actions">
        <div className="toolbar-spacer" />
        {info && (
          <button type="button" className="btn ghost about-copy" onClick={() => void copy()}>
            {copied ? t("about.copied") : t("about.copy")}
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </Dialog>
  );
}

/** Weak version label that opens the About dialog. */
export function VersionChip() {
  const info = useAppInfo();
  const [open, setOpen] = useState(false);
  const label = info ? `v${info.version} · ${shortRev(info.git)}` : "v…";

  return (
    <>
      <button
        type="button"
        className="version-chip"
        title={t("about.open")}
        aria-label={t("about.open")}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && <AboutDialog info={info} onClose={() => setOpen(false)} />}
    </>
  );
}