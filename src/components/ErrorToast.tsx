import { useEffect } from "react";
import { useWorkspace } from "../stores/workspace";
import { IconAlert } from "./icons";
import { t } from "../i18n";

export default function ErrorToast() {
  const error = useWorkspace((s) => s.error);
  const clear = useWorkspace((s) => s.clearError);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clear, 6000);
    return () => clearTimeout(t);
  }, [error, clear]);

  if (!error) return null;
  return (
    <div className="toast" role="alert" onClick={clear} title={t("common.clickToClose")}>
      <span className="toast-icon">
        <IconAlert size={13} />
      </span>
      <span className="toast-text">{error}</span>
    </div>
  );
}