import { useState } from "react";
import { pickNewWorkspacePath, pickWorkspaceFile } from "../ipc";
import { baseName, useWorkspace } from "../stores/workspace";
import { t } from "../i18n";
import { Field, Input } from "../ui/Field";
import { ThemeSwitch } from "../ui/ThemeSwitch";
import { IconDatabase, IconFolder, IconLock, IconPlus } from "./icons";

/**
 * Two modes in one card:
 * - `unlock`: a workspace is already known (file association, or the last one
 *   opened), so only the password is asked.
 * - full form: pick a file / create a new workspace.
 */
export default function Welcome() {
  const openWorkspace = useWorkspace((s) => s.openWorkspace);
  const createWorkspace = useWorkspace((s) => s.createWorkspace);
  const lastWorkspace = useWorkspace((s) => s.lastWorkspace);
  const recent = useWorkspace((s) => s.recent);
  const pendingPath = useWorkspace((s) => s.pendingPath);
  const requestPath = useWorkspace((s) => s.requestPath);
  const booted = useWorkspace((s) => s.booted);
  const storeError = useWorkspace((s) => s.error);

  const [mode, setMode] = useState<"open" | "create">("open");
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** "打开其他文件": leave the unlock view for the full form. */
  const [showForm, setShowForm] = useState(false);
  /** A recent entry picked from the list (wins over the remembered file). */
  const [picked, setPicked] = useState<string | null>(null);

  const fallback = pendingPath ?? picked ?? (lastWorkspace?.exists ? lastWorkspace.path : null);
  const target = showForm ? null : fallback;
  const missingLast = !pendingPath && !picked && lastWorkspace !== null && !lastWorkspace.exists;

  const browse = async () => {
    const p = mode === "open" ? await pickWorkspaceFile() : await pickNewWorkspacePath();
    if (p) setPath(p);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!path.trim()) return setLocalError(t("welcome.errorPathRequired"));
    if (!password) return setLocalError(t("welcome.errorPasswordRequired"));
    if (mode === "create" && password !== confirmPw) {
      return setLocalError(t("welcome.errorPasswordMismatch"));
    }
    setBusy(true);
    try {
      if (mode === "open") {
        await openWorkspace(path.trim(), password);
      } else {
        await createWorkspace(path.trim(), password);
      }
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!target) return;
    if (!password) return setLocalError(t("welcome.errorPasswordRequired"));
    setBusy(true);
    try {
      await openWorkspace(target, password);
      // A wrong password keeps the unlock card up; clear it for another try.
      if (useWorkspace.getState().error) setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const openOtherFile = () => {
    requestPath(null);
    setPicked(null);
    setShowForm(true);
    setMode("open");
    setPassword("");
    setLocalError(null);
  };

  const pickRecent = (p: string) => {
    requestPath(null);
    setPicked(p);
    setShowForm(false);
    setPassword("");
    setLocalError(null);
  };

  const error = localError ?? storeError;
  const recents = recent.filter((r) => !target || r.path !== target);
  /** Only the remembered file can be returned to: picking "other" drops the rest. */
  const backTarget = picked ?? (lastWorkspace?.exists ? lastWorkspace.path : null);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">
          <img className="brand-logo" src="/icon.png" alt="" />
          <div className="welcome-brand-text">
            <h1>nothing</h1>
            <p className="brand-sub">{t("welcome.tagline")}</p>
          </div>
        </div>

        {!booted ? (
          <p className="welcome-loading">{t("common.loading")}</p>
        ) : target ? (
          <>
            <div className="unlock-file">
              <span className="unlock-icon">
                <IconDatabase size={18} />
              </span>
              <div className="unlock-meta">
                <span className="unlock-name">{baseName(target)}</span>
                <span className="unlock-path" title={target}>
                  {target}
                </span>
              </div>
            </div>

            <form onSubmit={unlock} className="form">
              <Field label={t("welcome.password")}>
                <Input
                  type="password"
                  value={password}
                  autoFocus
                  autoComplete="off"
                  placeholder={t("welcome.passwordPlaceholder")}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {error && <div className="form-error">{error}</div>}
              <button type="submit" className="btn primary btn-block" disabled={busy}>
                {busy ? t("welcome.processing") : t("welcome.unlockAction")}
              </button>
            </form>

            <button type="button" className="btn ghost btn-block" onClick={openOtherFile}>
              <IconFolder size={14} /> {t("welcome.openOtherFile")}
            </button>
          </>
        ) : (
          <>
            <div className="tabs">
              <button
                className={mode === "open" ? "tab active" : "tab"}
                onClick={() => {
                  setMode("open");
                  setLocalError(null);
                }}
              >
                <IconDatabase size={14} /> {t("welcome.openTab")}
              </button>
              <button
                className={mode === "create" ? "tab active" : "tab"}
                onClick={() => {
                  setMode("create");
                  setLocalError(null);
                }}
              >
                <IconPlus size={14} /> {t("welcome.createTab")}
              </button>
            </div>

            {missingLast && lastWorkspace && (
              <p className="hint note">
                <IconDatabase size={13} />{" "}
                {t("welcome.lastMissing", { name: baseName(lastWorkspace.path) })}
              </p>
            )}

            <form onSubmit={submit} className="form">
              <Field label={mode === "open" ? t("welcome.workspaceFile") : t("welcome.savePath")}>
                <div className="path-row">
                  <Input
                    value={path}
                    placeholder={
                      mode === "open" ? t("welcome.chooseFile") : t("welcome.chooseSavePath")
                    }
                    onChange={(e) => setPath(e.target.value)}
                  />
                  <button type="button" className="btn" onClick={() => void browse()}>
                    <IconFolder size={14} /> {t("welcome.browse")}
                  </button>
                </div>
              </Field>
              <Field label={mode === "open" ? t("welcome.password") : t("welcome.setPassword")}>
                <Input
                  type="password"
                  value={password}
                  autoComplete="off"
                  placeholder={t("welcome.passwordPlaceholder")}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {mode === "create" && (
                <>
                  <Field label={t("welcome.confirmPassword")}>
                    <Input
                      type="password"
                      value={confirmPw}
                      autoComplete="off"
                      placeholder={t("welcome.confirmPlaceholder")}
                      onChange={(e) => setConfirmPw(e.target.value)}
                    />
                  </Field>
                  <p className="hint note">
                    <IconLock size={13} /> {t("welcome.cipherNote")}
                  </p>
                </>
              )}
              {error && <div className="form-error">{error}</div>}
              <button type="submit" className="btn primary btn-block" disabled={busy}>
                {busy
                  ? t("welcome.processing")
                  : mode === "open"
                    ? t("welcome.openAction")
                    : t("welcome.createAction")}
              </button>
            </form>

            {backTarget && (
              <button
                type="button"
                className="btn ghost btn-block"
                onClick={() => {
                  setShowForm(false);
                  setPassword("");
                  setLocalError(null);
                }}
              >
                <IconDatabase size={14} />{" "}
                {t("welcome.backToLast", { name: baseName(backTarget) })}
              </button>
            )}
          </>
        )}

        {booted && recents.length > 0 && (
          <div className="recent-files">
            <div className="recent-files-head">{t("welcome.recent")}</div>
            <ul className="recent-list">
              {recents.map((r) => (
                <li key={r.path}>
                  <button
                    type="button"
                    className="recent-item"
                    disabled={!r.exists}
                    title={r.exists ? r.path : t("welcome.missing")}
                    onClick={() => pickRecent(r.path)}
                  >
                    <span className="recent-name">{baseName(r.path)}</span>
                    <span className="recent-path">{r.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="welcome-foot">
          <span>
            <span className="dot" /> {t("welcome.localOnly")}
          </span>
          <ThemeSwitch compact />
        </div>
      </div>
    </div>
  );
}