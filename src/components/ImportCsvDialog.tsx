// CSV import confirmation: shows the first record as an editable header row
// inside the data preview, lets the user pick column types, then imports into a
// brand-new table. Header name + type sit in the preview table's sticky header
// so every editor stays aligned with the column it belongs to.

import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { errorText, t } from "../i18n";
import { useWorkspace } from "../stores/workspace";
import type { ColumnType, CsvPreview, ImportReport } from "../types";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select } from "../ui/Field";
import { ColumnTypeIcon, IconAlert, IconCheck, IconUpload } from "./icons";

const IMPORT_TYPES = ["text", "number", "date", "checkbox"] as const;
type ImportType = (typeof IMPORT_TYPES)[number];

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function defaultTableName(path: string): string {
  const name = baseName(path);
  return name.replace(/\.[^.]+$/, "") || name;
}

export default function ImportCsvDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const importCsv = useWorkspace((s) => s.importCsv);

  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tableName, setTableName] = useState(() => defaultTableName(path));
  const [useHeader, setUseHeader] = useState(true);
  const [headers, setHeaders] = useState<string[]>([]);
  const [types, setTypes] = useState<ImportType[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    ipc
      .csvPreview(path, 20)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setHeaders(
          p.first_row.map((h, i) => h.trim() || t("importCsv.columnFallback", { n: i + 1 })),
        );
        // The first column is always the title column.
        setTypes(p.suggested_types.map((ty, i) => (i === 0 ? "text" : asImportType(ty))));
      })
      .catch((e) => {
        if (alive) setLoadError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const trimmedHeaders = useMemo(() => headers.map((h) => h.trim()), [headers]);
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const name of trimmedHeaders) {
      if (!name) continue;
      if (seen.has(name)) dup.add(name);
      seen.add(name);
    }
    return dup;
  }, [trimmedHeaders]);

  const headerError = useMemo(() => {
    if (trimmedHeaders.some((h) => !h)) return t("importCsv.headerRequired");
    if (duplicateNames.size > 0)
      return t("importCsv.headerDuplicate", { names: [...duplicateNames].join("、") });
    return null;
  }, [trimmedHeaders, duplicateNames]);

  const dataRows = useMemo(() => {
    if (!preview) return [];
    const all = useHeader ? preview.rows : [preview.first_row, ...preview.rows];
    return all.slice(0, 10);
  }, [preview, useHeader]);

  const dataCount = preview ? Math.max(0, preview.total_rows - (useHeader ? 1 : 0)) : 0;

  const toggleHeader = (next: boolean) => {
    setUseHeader(next);
    if (!preview) return;
    setHeaders(
      preview.first_row.map((h, i) =>
        next ? h.trim() || t("importCsv.columnFallback", { n: i + 1 }) : t("importCsv.columnFallback", { n: i + 1 }),
      ),
    );
  };

  const toggleType = (index: number, value: string) => {
    setTypes((prev) => prev.map((ty, i) => (i === index ? (value as ImportType) : ty)));
  };

  const submit = async () => {
    if (!preview || headerError) return;
    const name = tableName.trim();
    if (!name) {
      setError(t("importCsv.tableNameRequired"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await importCsv({
        path,
        table_name: name,
        use_header: useHeader,
        headers: trimmedHeaders,
        types,
      });
      if (result) {
        setReport(result);
      } else {
        setError(t("importCsv.failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  if (report) {
    return (
      <Dialog title={t("importCsv.resultTitle")} onClose={onClose}>
        <div className="csv-result">
          <span className="csv-result-mark">
            <IconCheck size={22} />
          </span>
          <p className="csv-result-title">
            {t("importCsv.resultSummary", { count: report.imported, name: report.table.name })}
          </p>
          {report.invalid_cells > 0 && (
            <p className="hint">{t("importCsv.invalidCells", { count: report.invalid_cells })}</p>
          )}
          <div className="modal-actions">
            <div className="toolbar-spacer" />
            <button type="button" className="btn primary" onClick={onClose}>
              {t("importCsv.openTable")}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t("importCsv.title")} subtitle={t("importCsv.subtitle")} onClose={onClose} xwide>
      {loading ? (
        <p className="hint">{t("importCsv.loading")}</p>
      ) : loadError ? (
        <div className="form">
          <div className="form-error">{`${t("importCsv.loadFailed")}：${loadError}`}</div>
          <div className="modal-actions">
            <div className="toolbar-spacer" />
            <button type="button" className="btn" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : preview ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="csv-file">
            <IconUpload size={15} />
            <span className="csv-file-name" title={path}>
              {baseName(path)}
            </span>
            <span className="csv-file-meta">
              {t("importCsv.rows", { count: dataCount })} ·{" "}
              {preview.encoding === "gb18030" ? "GB18030" : "UTF-8"} ·{" "}
              {preview.delimiter === "\t" ? t("importCsv.delimiterTab") : preview.delimiter}
            </span>
          </div>

          <Field label={t("importCsv.tableName")}>
            <Input
              className="ui-input csv-table-name"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder={t("importCsv.tableNamePlaceholder")}
              autoFocus
            />
          </Field>

          <div className="builder">
            <div className="builder-head">
              <span>{t("importCsv.headerRow")}</span>
              <label className="csv-toggle-inline">
                <input
                  type="checkbox"
                  checked={useHeader}
                  onChange={(e) => toggleHeader(e.target.checked)}
                />
                {t("importCsv.useHeader")}
              </label>
            </div>

            <div className="csv-grid-wrap">
              <table className="csv-table">
                <thead>
                  <tr>
                    {headers.map((h, i) => (
                      <th key={i} className="csv-head-cell">
                        <Input
                          className="ui-input csv-head-name"
                          value={h}
                          invalid={!h.trim() || duplicateNames.has(h.trim())}
                          aria-label={t("importCsv.columnFallback", { n: i + 1 })}
                          onChange={(e) =>
                            setHeaders((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                          }
                        />
                        <span
                          className="csv-head-type"
                          title={i === 0 ? t("importCsv.titleLocked") : undefined}
                        >
                          <Select
                            value={types[i] ?? "text"}
                            onChange={(v) => toggleType(i, v)}
                            disabled={i === 0}
                            ariaLabel={t("importCsv.columnFallback", { n: i + 1 })}
                            options={IMPORT_TYPES.map((value) => ({
                              value,
                              label: t(`types.${value}`),
                              leading: <ColumnTypeIcon type={value} size={13} />,
                            }))}
                          />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataRows.length === 0 ? (
                    <tr>
                      <td className="csv-table-empty" colSpan={Math.max(headers.length, 1)}>
                        {t("importCsv.previewEmpty")}
                      </td>
                    </tr>
                  ) : (
                    dataRows.map((row, ri) => (
                      <tr key={ri}>
                        {headers.map((_, ci) => {
                          const cell = row[ci] ?? "";
                          return (
                            <td key={ci} title={cell}>
                              {cell}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="csv-foot">
              <p className="hint">
                {useHeader ? t("importCsv.headerRowHint") : t("importCsv.useHeaderHint")}
                {" · "}
                {t("importCsv.titleLocked")}
              </p>
              {dataRows.length > 0 && (
                <span className="builder-count">
                  {t("importCsv.previewMore", { count: dataRows.length, total: dataCount })}
                </span>
              )}
            </div>

            {preview.ragged && (
              <p className="hint note">
                <IconAlert size={13} />
                {t("importCsv.ragged")}
              </p>
            )}
            {headerError && <div className="form-error">{headerError}</div>}
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <div className="toolbar-spacer" />
            <button
              type="submit"
              className="btn primary"
              disabled={busy || !!headerError || !tableName.trim()}
            >
              {busy ? t("importCsv.importing") : t("importCsv.importAction")}
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/** Preview types can include everything ColumnType offers; import supports four. */
function asImportType(ty: ColumnType): ImportType {
  return (IMPORT_TYPES as readonly string[]).includes(ty) ? (ty as ImportType) : "text";
}