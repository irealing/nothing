// Schema browser for the scratch SQL console.
//
// Tables are addressed by physical names (`t_<ULID>`) that can't be guessed
// from the UI, so this popover lists every table + column and turns a click on
// a table into a ready-to-run SELECT. Read-only data only; nothing is written.

import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { useWorkspace } from "../stores/workspace";
import { errorText, t } from "../i18n";
import { Popover } from "../ui/Popover";
import { IconChevronDown, IconChevronRight, IconTable } from "./icons";
import type { ColumnMeta, TableMeta } from "../types";
import { colType, isReverse, sqlNameOf } from "../types";

export interface SchemaGroup {
  table: TableMeta;
  /** Columns backed by a real column in `t_<id>` (formula columns included). */
  physical: ColumnMeta[];
  /** Relation columns; their values live in `r_<column_id>`. */
  relations: ColumnMeta[];
}

/**
 * Group columns per table. Reverse relation columns are dropped: they share
 * the source column's junction table and would only duplicate the row.
 */
export function groupSchema(
  tables: TableMeta[],
  columnsByTable: Map<string, ColumnMeta[]>,
): SchemaGroup[] {
  return [...tables]
    .sort((a, b) => a.position - b.position)
    .map((table) => {
      const cols = [...(columnsByTable.get(table.id) ?? [])].sort(
        (a, b) => a.position - b.position,
      );
      return {
        table,
        physical: cols.filter((c) => colType(c) !== "relation" && !isReverse(c)),
        relations: cols.filter((c) => colType(c) === "relation" && !isReverse(c)),
      };
    });
}

/** SQL identifier quoting, mirroring the core's `quote_ident`. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function tableQuery(sqlName: string): string {
  return `SELECT * FROM ${quoteIdent(sqlName)} LIMIT 100`;
}

export function SchemaBrowser({
  onPickTable,
}: {
  /** Called with the physical table name when the user clicks a table. */
  onPickTable: (sqlName: string) => void;
}) {
  const dataVersion = useWorkspace((s) => s.dataVersion);
  const activeTableId = useWorkspace((s) => s.activeTableId);

  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<SchemaGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cache = useRef<{ version: number; groups: SchemaGroup[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (cache.current?.version === dataVersion) {
      setGroups(cache.current.groups);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const tables = await ipc.tableList();
        const columns = await Promise.all(tables.map((x) => ipc.columnList(x.id)));
        const next = groupSchema(tables, new Map(tables.map((x, i) => [x.id, columns[i]])));
        if (cancelled) return;
        cache.current = { version: dataVersion, groups: next };
        setGroups(next);
        setExpanded((cur) => cur ?? activeTableId ?? tables[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, dataVersion, activeTableId]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="schema-popover"
      trigger={
        <button type="button" className="btn ghost">
          <IconTable size={13} /> {t("sql.schema")}
        </button>
      }
    >
      <div className="schema-browser">
        <div className="schema-head">
          <span className="schema-title">{t("sql.schema")}</span>
          <span className="schema-hint">{t("sql.schemaHint")}</span>
        </div>
        {loading && <div className="schema-note">{t("sql.schemaLoading")}</div>}
        {error && <div className="form-error schema-note">{error}</div>}
        {!loading && !error && groups?.length === 0 && (
          <div className="schema-note">{t("sql.schemaEmpty")}</div>
        )}
        <div className="schema-list">
          {groups?.map((g) => {
            const isOpen = expanded === g.table.id;
            const Chevron = isOpen ? IconChevronDown : IconChevronRight;
            return (
              <div className="schema-group" key={g.table.id}>
                <div className="schema-row">
                  <button
                    type="button"
                    className="schema-toggle"
                    aria-expanded={isOpen}
                    aria-label={t("sql.schemaExpand")}
                    onClick={() => setExpanded(isOpen ? null : g.table.id)}
                  >
                    <Chevron size={12} />
                  </button>
                  <button
                    type="button"
                    className="schema-table"
                    title={tableQuery(g.table.sql_name)}
                    onClick={() => {
                      onPickTable(g.table.sql_name);
                      setOpen(false);
                    }}
                  >
                    <span className="schema-emoji">
                      {g.table.icon ?? <IconTable size={14} />}
                    </span>
                    <span className="schema-names">
                      <span className="schema-name">{g.table.name}</span>
                      <code className="schema-sql">{g.table.sql_name}</code>
                    </span>
                    <span className="schema-count">{g.physical.length}</span>
                  </button>
                </div>
                {isOpen && (
                  <div className="schema-cols">
                    {g.physical.map((c) => (
                      <div className="schema-col" key={c.id}>
                        <span className="schema-name">{c.name}</span>
                        <code className="schema-sql">{sqlNameOf(c)}</code>
                        <span className="schema-type">{colType(c)}</span>
                      </div>
                    ))}
                    {g.relations.map((c) => (
                      <div className="schema-col" key={c.id}>
                        <span className="schema-name">{c.name}</span>
                        <code className="schema-sql">{`r_${c.id.toLowerCase()}`}</code>
                        <span className="schema-type">{t("sql.schemaRelation")}</span>
                      </div>
                    ))}
                    <div className="schema-fixed">{t("sql.schemaFixed")}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="schema-foot">{t("sql.schemaReplaceHint")}</div>
      </div>
    </Popover>
  );
}