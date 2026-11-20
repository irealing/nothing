import { useState } from "react";
import { pickNewWorkspacePath, pickWorkspaceFile } from "../ipc";
import { useWorkspace } from "../stores/workspace";
import { t } from "../i18n";
import { Field, Input } from "../ui/Field";
import { ThemeSwitch } from "../ui/ThemeSwitch";
import { IconDatabase, IconFolder, IconLock, IconPlus } from "./icons";

export default function Welcome() {
  const openWorkspace = useWorkspace((s) => s.openWorkspace);
  const createWorkspace = useWorkspace((s) => s.createWorkspace);
  const storeError = useWorkspace((s) => s.error);

  const [mode, setMode] = useState<"open" | "create">("open");
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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

  const error = localError ?? storeError;

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