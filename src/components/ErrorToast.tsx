import { useEffect } from "react";
import { useWorkspace } from "../stores/workspace";

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
    <div className="toast" role="alert" onClick={clear}>
      <span className="toast-icon">!</span>
      <span>{error}</span>
    </div>
  );
}
