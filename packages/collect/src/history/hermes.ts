// SPDX-License-Identifier: AGPL-3.0-only
// Hermes keeps every session in one SQLite database; an assistant message's
// tool_calls column is a JSON list of function calls. The database is read
// through the sqlite3 command in read-only mode, one query for the two
// columns this needs.
import type { Host } from "../host.js";
import { type Call, type HistoryReader, isRecord, tryJson } from "./reader.js";

const QUERY = "select session_id, tool_calls from messages where tool_calls is not null";

export function hermesCall(session: string, name: string, args: unknown): Call {
  const arg = isRecord(args) ? args : {};
  if (name === "terminal" && typeof arg["command"] === "string") return { session, kind: "shell", line: arg["command"] };
  return { session, kind: "other", name };
}

/** The calls in one row's tool_calls JSON. */
export function hermesCalls(session: string, toolCalls: unknown): Call[] {
  const list = typeof toolCalls === "string" ? tryJson(toolCalls) : toolCalls;
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => {
    const fn = isRecord(item) && isRecord(item["function"]) ? item["function"] : undefined;
    if (fn === undefined || typeof fn["name"] !== "string") return [];
    const args = typeof fn["arguments"] === "string" ? tryJson(fn["arguments"]) : fn["arguments"];
    return [hermesCall(session, fn["name"], args)];
  });
}

export const hermesReader: HistoryReader = {
  async *read(host: Host, root: string): AsyncIterable<Call> {
    if ((await host.fs.stat(root)) === undefined) return;
    const out = await host.exec.run("sqlite3", ["-readonly", "-json", root, QUERY]);
    if (out === undefined) throw new Error(`${root} could not be read with sqlite3`);
    const rows = out.trim() === "" ? [] : tryJson(out);
    if (!Array.isArray(rows)) throw new Error(`${root}: sqlite3 returned no JSON`);
    for (const row of rows) {
      if (!isRecord(row) || typeof row["session_id"] !== "string") continue;
      yield* hermesCalls(row["session_id"], row["tool_calls"]);
    }
  },
};
