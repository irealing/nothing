// The two "get started" entry points shared by the sidebar empty state and the
// main empty card: create a table, or import a CSV. Each host owns its dialogs,
// which keeps the permission boundary simple (no global dialog store).

import { useState } from "react";
import * as ipc from "../ipc";
import { CreateTableDialog } from "./dialogs";
import ImportCsvDialog from "./ImportCsvDialog";
import { IconPlus, IconUpload } from "./icons";
import { t } from "../i18n";

export default function StartActions({ className }: { className?: string }) {
  const [creating, setCreating] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);

  const pickCsv = async () => {
    try {
      const picked = await ipc.pickCsvFile();
      if (picked) setImportPath(picked);
    } catch {
      // The native dialog failing is non-fatal; keep the UI as-is.
    }
  };

  return (
    <div className={className ?? "start-actions"}>
      <button className="btn primary" onClick={() => setCreating(true)}>
        <IconPlus size={14} /> {t("sidebar.newTableAction")}
      </button>
      <button className="btn" onClick={() => void pickCsv()}>
        <IconUpload size={14} /> {t("importCsv.action")}
      </button>
      {creating && <CreateTableDialog onClose={() => setCreating(false)} />}
      {importPath && <ImportCsvDialog path={importPath} onClose={() => setImportPath(null)} />}
    </div>
  );
}