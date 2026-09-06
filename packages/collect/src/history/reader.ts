// SPDX-License-Identifier: AGPL-3.0-only
// One reader per session store format. A reader turns its agent's own
// transcripts into tool calls and nothing else: a shell line is handed to the
// command parser and dropped, any other tool is a name. No line, argument or
// result an agent saw is kept or returned.
import type { Host } from "../host.js";

export type Call = { session: string; kind: "shell"; line: string } | { session: string; kind: "other"; name: string };

export interface HistoryReader {
  /** Every tool call under root (absolute: a directory of transcripts or one database file), keyed by the top-level
   * session it belongs to. Nothing when the root is not there; a throw when it is there and cannot be read. */
  read(host: Host, root: string): AsyncIterable<Call>;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The file's name without its directory or extension. */
export function stem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
