// SPDX-License-Identifier: AGPL-3.0-only
// The agents that index sessions in sqlite get their rows updated through
// node's own binding, so the engine carries no native dependency. A missing
// database is nothing found, never created.
import { existsSync } from "node:fs";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { pyData } from "./py.js";

export interface RowUpdate {
  sql: string;
  params: Readonly<Record<string, SQLInputValue>>;
}

/** True when the column is $from or a folder under it; a sibling sharing the prefix is not. */
export const underPath = (column: string): string => `(${column} = $from or substr(${column}, 1, length($from) + 1) = $from || '/')`;
/** The column with $from swapped for $to when it is at or under $from, else itself. */
export const movedColumn = (column: string): string => `iif(${underPath(column)}, $to || substr(${column}, length($from) + 1), ${column})`;
export const pathParams = (from: string, to: string): Record<string, SQLInputValue> => ({ $from: from, $to: to });

// Fetched on first use, not at import: loading node:sqlite prints an ExperimentalWarning, and vite-node 2 cannot resolve an import of it.
const binding = (): typeof import("node:sqlite") => process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** Runs fn on the database opened read-only, or returns nothing when the file is absent. */
export function readOnly<T>(db: string, fn: (d: DatabaseSync) => T): T | undefined {
  if (!existsSync(db)) return undefined;
  const { DatabaseSync } = binding();
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

/** The `n` the count query selects, or zero when the file is absent. */
export const countRows = (db: string, sql: string, params: Readonly<Record<string, SQLInputValue>>): number =>
  readOnly(db, d => Number((d.prepare(sql).get(params) as { n: number | bigint }).n)) ?? 0;

/** Runs fn on the open database inside one transaction, or returns nothing when the file is absent. */
export function inTransaction<T>(db: string, fn: (d: DatabaseSync) => T): T | undefined {
  if (!existsSync(db)) return undefined;
  const { DatabaseSync } = binding();
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

/** The rows the select finds, by column name, or nothing when the file is absent. */
export const selectRows = (db: string, sql: string, params: Readonly<Record<string, SQLInputValue>>): Record<string, SQLOutputValue>[] | undefined =>
  readOnly(db, d => d.prepare(sql).all(params).map(r => ({ ...r })));

/** How one table's rows meet the machine's. With a key: inserted when the key is absent, and when present only the
 * `set` path columns change, every other column staying the machine's. Without one (an autoincrement id): the rows
 * are inserted, less the `drop` columns, when the machine holds no row whose `by` column matches theirs, else kept
 * as a group. */
export type MergeMode = { key: readonly string[]; set: readonly string[] } | { by: string; drop: readonly string[] };
export type MergeTable = { table: string; rows: readonly Record<string, SQLOutputValue>[] } & MergeMode;

/** A blob as the script carries it; every other value is JSON already. */
const portable = (row: Record<string, SQLOutputValue>): Record<string, unknown> => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { $blob: Buffer.from(v).toString("base64") } : v]));

/**
 * A merge script step over the machine's copy of the store, each table by its MergeMode; a path column changes only
 * when it differs, so a second run changes nothing and a repeat import never clobbers a row the agent updated there.
 * A machine without the store, or its table, waits; the agent's own migrations make its schema, never this. One
 * transaction per store.
 */
export function sqliteMergeStep(db: string, tables: readonly MergeTable[]): string {
  return [
    `DB = ${pyData(db)}`,
    "if not os.path.exists(DB):",
    '    out({"waiting": "no " + DB + " on the machine"})',
    `TABLES = ${pyData(tables.map(t => ({ ...t, rows: t.rows.map(portable) })))}`,
    "con = sqlite3.connect(DB)",
    "names = {r[0] for r in con.execute(\"select name from sqlite_master where type = 'table'\")}",
    "for t in TABLES:",
    '    if t["table"] not in names:',
    '        out({"waiting": "no table " + t["table"] + " in " + DB})',
    "def q(name):",
    "    return '\"' + name.replace('\"', '\"\"') + '\"'",
    "def value(v):",
    '    return base64.b64decode(v["$blob"]) if isinstance(v, dict) else v',
    "def insert(t, row, cols, on_conflict):",
    '    sql = "insert into " + q(t["table"]) + " (" + ", ".join(q(c) for c in cols) + ") values (" + ", ".join("?" for c in cols) + ")" + on_conflict',
    "    return con.execute(sql, [value(row[c]) for c in cols]).rowcount",
    "def merge_table(t):",
    "    global merged, kept",
    '    if "by" in t:',
    "        groups = {}",
    '        for row in t["rows"]:',
    '            groups.setdefault(row[t["by"]], []).append(row)',
    "        for owner, rows in groups.items():",
    '            held = con.execute("select count(*) from " + q(t["table"]) + " where " + q(t["by"]) + " = ?", (owner,)).fetchone()[0]',
    "            if held:",
    "                kept += len(rows)",
    "                continue",
    "            for row in rows:",
    '                merged += insert(t, row, [c for c in row if c not in t["drop"]], "")',
    "        return",
    '    if t["set"]:',
    '        action = "update set " + ", ".join(q(c) + " = excluded." + q(c) for c in t["set"]) + " where " + " or ".join(q(t["table"]) + "." + q(c) + " is not excluded." + q(c) for c in t["set"])',
    "    else:",
    '        action = "nothing"',
    '    for row in t["rows"]:',
    '        n = insert(t, row, list(row), " on conflict (" + ", ".join(q(c) for c in t["key"]) + ") do " + action)',
    "        merged += n",
    "        kept += 1 - n",
    "try:",
    "    with con:",
    "        for t in TABLES:",
    "            merge_table(t)",
    "except sqlite3.Error as e:",
    '    fail("merge into " + DB + " failed: " + str(e))',
    "finally:",
    "    con.close()",
  ].join("\n");
}

/** Runs one update and returns the rows it changed. */
export const runUpdate = (d: DatabaseSync, u: RowUpdate): number => Number(d.prepare(u.sql).run(u.params).changes);

/** Runs each update in one transaction and returns the rows each one changed, or nothing when the file is absent. */
export const updateRows = (db: string, updates: readonly RowUpdate[]): number[] | undefined =>
  inTransaction(db, d => updates.map(u => runUpdate(d, u)));
