// SPDX-License-Identifier: AGPL-3.0-only
// What Codex itself calls a thread, read from the thread index in CODEX_HOME:
// state_<schema version>.sqlite, table threads, one row per thread id (the
// catalog's measured row for codex). Two columns name a thread: title, which
// the CLI fills from the thread's opening words and never leaves null, and
// name, which stays null until the person names the thread, so name wins where
// it has one. Measured on codex-cli 0.153.0 against state_5.sqlite.

import { shellQuote } from "@wsp/protocol";
import { slug } from "./command.js";

/**
 * One shell line for the guest: the thread's row as JSON, out of the highest-versioned state db (the file name
 * carries the schema version, so a codex upgrade moves it). The names are sorted inside CODEX_HOME on the number
 * after the underscore, so state_10 beats state_5 and a home whose own path holds an underscore cannot confuse the
 * field. Read-only, so a running codex keeps its write lock, and json_object rather than printed columns, since a
 * name may hold whatever character a separator would use. Nothing on stdout when the machine has no sqlite3, no
 * state db or no such row, which reads as no title.
 */
export function sessionTitleCommand(options: { home: string; threadId: string }): string {
  const query = `select json_object('name', name, 'title', title) from threads where id = '${slug("threadId", options.threadId)}' limit 1;`;
  return (
    `command -v sqlite3 > /dev/null 2>&1 || exit 0; ` +
    `cd ${shellQuote(options.home)} 2>/dev/null || exit 0; ` +
    `d=$(ls -1 state_*.sqlite 2>/dev/null | sort -t_ -k2,2n | tail -n 1); [ -n "$d" ] || exit 0; ` +
    `sqlite3 -readonly "$d" ${shellQuote(query)} 2>/dev/null; true`
  );
}

/** The thread's name where the person gave it one, else the title the CLI derived; null when the row is missing or both are blank. */
export function parseSessionTitle(stdout: string): string | null {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    for (const column of ["name", "title"] as const) {
      const title = (typeof row[column] === "string" ? (row[column] as string) : "").trim();
      if (title !== "") return title;
    }
    return null;
  }
  return null;
}
