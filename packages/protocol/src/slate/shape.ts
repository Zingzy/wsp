// SPDX-License-Identifier: AGPL-3.0-only
// A tool or resource run's result by its shape (07, "MCP tools and resources"), one decision the window draws and
// the sketch says: a list of records is a table, a record is facts with its lists and records under their names, a
// list of plain values or a text is text. The server's field names become column titles and fact labels.
import type { SlateJson } from "./types.js";

type JsonRecord = { [key: string]: SlateJson };
export type SlateResultShape =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "table"; rows: JsonRecord[]; columns: { key: string; title: string }[] }
  | { kind: "record"; facts: { label: string; value: string }[]; nested: { title: string; shape: SlateResultShape }[] };

export const SLATE_RESULT_ROWS = 50;
const COLUMNS = 6;
/** Below this depth a nested value is one fact of JSON. */
const DEPTH = 2;
const PATH_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const isRecord = (v: SlateJson | undefined): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: SlateJson | undefined): v is string | number | boolean | null => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const isPlainList = (v: SlateJson): v is (string | number | boolean | null)[] => Array.isArray(v) && v.every(isScalar);

/** A field name as a label: `receivedTime` and `received_time` read "Received time". */
export function slateFieldWords(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return spaced === "" ? key : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/** The fields that hold a plain value in some row, in the order rows name them; a row reads them as `item.<key>`. */
function columnsOf(rows: readonly JsonRecord[]): string[] {
  const keys: string[] = [];
  for (const row of rows.slice(0, SLATE_RESULT_ROWS)) {
    for (const [key, value] of Object.entries(row)) {
      if (keys.length >= COLUMNS) return keys;
      if (!keys.includes(key) && PATH_KEY.test(key) && isScalar(value) && value !== null && value !== "") keys.push(key);
    }
  }
  return keys;
}

export function slateResultShape(value: SlateJson | undefined, depth = 0): SlateResultShape {
  if (value === undefined || value === null || value === "") return { kind: "none" };
  if (isScalar(value)) return { kind: "text", text: String(value) };
  if (Array.isArray(value)) {
    const rows = value.filter(isRecord);
    if (value.length > 0 && rows.length === value.length) return { kind: "table", rows, columns: columnsOf(rows).map(key => ({ key, title: slateFieldWords(key) })) };
    if (isPlainList(value)) return value.length === 0 ? { kind: "none" } : { kind: "text", text: value.map(String).join("\n") };
    return { kind: "text", text: JSON.stringify(value) };
  }
  const facts: { label: string; value: string }[] = [];
  const nested: { title: string; shape: SlateResultShape }[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (isScalar(v) || isPlainList(v)) {
      const shown = Array.isArray(v) ? v.map(String).join(", ") : v === null ? "" : String(v);
      if (shown !== "") facts.push({ label: slateFieldWords(key), value: shown });
    } else if (depth + 1 >= DEPTH) facts.push({ label: slateFieldWords(key), value: JSON.stringify(v) });
    else nested.push({ title: slateFieldWords(key), shape: slateResultShape(v, depth + 1) });
  }
  return { kind: "record", facts, nested };
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The shape as the sketch says it: what kind of thing shows, its size and its names, never a page of data. */
export function sketchSlateResult(shape: SlateResultShape): string[] {
  switch (shape.kind) {
    case "none":
      return [];
    case "text": {
      const lines = shape.text.split("\n").filter(l => l !== "");
      return [lines.length <= 1 ? `text: ${cut(lines[0] ?? "", 60)}` : `text, ${lines.length} lines: ${cut(lines[0]!, 48)}`];
    }
    case "table": {
      const shown = Math.min(shape.rows.length, SLATE_RESULT_ROWS);
      const more = shape.rows.length > shown ? ` and ${shape.rows.length - shown} more` : "";
      return [`table of ${shown} row${shown === 1 ? "" : "s"}${more}: ${shape.columns.map(c => c.title).join(", ")}`];
    }
    case "record":
      return [
        ...(shape.facts.length > 0 ? [shape.facts.map(f => `${f.label} ${cut(f.value, 24)}`).join(", ")] : []),
        ...shape.nested.flatMap(n => sketchSlateResult(n.shape).map((line, at) => (at === 0 ? `${n.title}: ${line}` : `  ${line}`))),
      ];
  }
}
