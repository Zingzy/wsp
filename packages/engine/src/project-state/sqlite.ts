// SPDX-License-Identifier: AGPL-3.0-only
// The agents that index sessions in sqlite (Codex, OpenCode, Hermes) get their
// rows updated through node's own sqlite binding, so the engine carries no
// native dependency. A missing database is nothing found, never created.
import { existsSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";

// vite-node 2 does not list node:sqlite as a builtin and would try to resolve it as a package.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export interface RowUpdate {
  sql: string;
  params: Readonly<Record<string, SQLInputValue>>;
}

/** True when the column is $from or a folder under it; a sibling sharing the prefix is not. */
export const underPath = (column: string): string => `(${column} = $from or substr(${column}, 1, length($from) + 1) = $from || '/')`;
/** The column with $from swapped for $to when it is at or under $from, else itself. */
export const movedColumn = (column: string): string => `iif(${underPath(column)}, $to || substr(${column}, length($from) + 1), ${column})`;
export const pathParams = (from: string, to: string): Record<string, SQLInputValue> => ({ $from: from, $to: to });

/** Runs each update in one transaction and returns the rows each one changed, or nothing when the file is absent. */
export function updateRows(db: string, updates: readonly RowUpdate[]): number[] | undefined {
  if (!existsSync(db)) return undefined;
  const d = new DatabaseSync(db);
  try {
    d.exec("begin");
    const changed = updates.map(u => Number(d.prepare(u.sql).run(u.params).changes));
    d.exec("commit");
    return changed;
  } finally {
    d.close();
  }
}
