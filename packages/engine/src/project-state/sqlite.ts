// SPDX-License-Identifier: AGPL-3.0-only
// The agents that index sessions in sqlite get their rows updated through
// node's own binding, so the engine carries no native dependency. A missing
// database is nothing found, never created.
import { existsSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export interface RowUpdate {
  sql: string;
  params: Readonly<Record<string, SQLInputValue>>;
}

/** True when the column is $from or a folder under it; a sibling sharing the prefix is not. */
export const underPath = (column: string): string => `(${column} = $from or substr(${column}, 1, length($from) + 1) = $from || '/')`;
/** The column with $from swapped for $to when it is at or under $from, else itself. */
export const movedColumn = (column: string): string => `iif(${underPath(column)}, $to || substr(${column}, length($from) + 1), ${column})`;
export const pathParams = (from: string, to: string): Record<string, SQLInputValue> => ({ $from: from, $to: to });

/** Runs fn on the open database inside one transaction, or returns nothing when the file is absent. */
export function inTransaction<T>(db: string, fn: (d: DatabaseSync) => T): T | undefined {
  if (!existsSync(db)) return undefined;
  // Fetched here, not at import: loading node:sqlite prints an ExperimentalWarning, and vite-node 2 cannot resolve an import of it.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const d = new DatabaseSync(db);
  try {
    d.exec("begin");
    const out = fn(d);
    d.exec("commit");
    return out;
  } finally {
    d.close();
  }
}

/** Runs one update and returns the rows it changed. */
export const runUpdate = (d: DatabaseSync, u: RowUpdate): number => Number(d.prepare(u.sql).run(u.params).changes);

/** Runs each update in one transaction and returns the rows each one changed, or nothing when the file is absent. */
export const updateRows = (db: string, updates: readonly RowUpdate[]): number[] | undefined =>
  inTransaction(db, d => updates.map(u => runUpdate(d, u)));
