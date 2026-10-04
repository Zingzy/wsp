// SPDX-License-Identifier: AGPL-3.0-only
// A tool or resource run's result drawn by its shape through the kit's own pieces (07, "MCP tools and resources"):
// a list of records as a table, a record as facts with its lists and records under their names, a list of plain
// values or a text as text. The server's field names become the column titles and fact labels.
import type { SlateJson, SlatePiece, SlatePropValue } from "@wsp/protocol";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { facts } from "./pieces/facts.js";
import { table } from "./pieces/table.js";
import { text } from "./pieces/text.js";
import type { PieceViewProps } from "./SlateView.js";

type Record_ = { [key: string]: SlateJson };
type Shared = Pick<PieceViewProps, "id" | "slate" | "raise" | "cancel" | "sender">;

export const SHAPE_ROWS = 50;
const SHAPE_COLUMNS = 6;
/** Below this depth a nested value is one line of JSON. */
const SHAPE_DEPTH = 2;

const isRecord = (v: SlateJson | undefined): v is Record_ => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: SlateJson | undefined): boolean => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const PATH_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A field name as a label: `receivedTime` and `received_time` read "Received time". */
export function wordsOf(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return spaced === "" ? key : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/** The columns a list of records draws: the fields that hold a plain value in some row, in the order rows name them. */
export function columnsOf(rows: readonly Record_[]): string[] {
  const keys: string[] = [];
  for (const row of rows.slice(0, SHAPE_ROWS)) {
    for (const [key, value] of Object.entries(row)) {
      if (keys.length >= SHAPE_COLUMNS) return keys;
      if (!keys.includes(key) && PATH_KEY.test(key) && isScalar(value) && value !== null && value !== "") keys.push(key);
    }
  }
  return keys;
}

function view(type: string, props: Record<string, SlatePropValue>): SlatePiece {
  return { type, props } as SlatePiece;
}

function Table({ rows, shared }: { rows: Record_[]; shared: Shared }) {
  const columns = columnsOf(rows).map(key => ({ title: wordsOf(key), value: { bind: `item.${key}` } }));
  const Component = table.component;
  return <Component {...shared} piece={view("table", { columns })} props={{ items: rows, rows: SHAPE_ROWS }}>{null}</Component>;
}

function Facts({ value, shared }: { value: Record_; shared: Shared }) {
  const list = Object.entries(value).flatMap(([key, v]) => (isScalar(v) || (Array.isArray(v) && v.every(isScalar)) ? [{ label: wordsOf(key), value: Array.isArray(v) ? v.map(String).join(", ") : v }] : []));
  if (list.length === 0) return null;
  const Component = facts.component;
  return <Component {...shared} piece={view("facts", {})} props={{ facts: list, layout: "grid" }}>{null}</Component>;
}

function Text({ value, shared }: { value: string; shared: Shared }) {
  const Component = text.component;
  return <Component {...shared} piece={view("text", {})} props={{ value }}>{null}</Component>;
}

/** The value by its shape; a record's lists and records draw under their names, one level down. */
export function ResultByShape({ value, shared, depth = 0 }: { value: SlateJson | undefined; shared: Shared; depth?: number }) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return <Text value={value} shared={shared} />;
  if (isScalar(value)) return <Text value={String(value)} shared={shared} />;
  if (Array.isArray(value)) {
    const rows = value.filter(isRecord);
    if (value.length > 0 && rows.length === value.length) return <Table rows={rows} shared={shared} />;
    if (value.every(isScalar)) return value.length === 0 ? null : <Text value={value.map(String).join("\n")} shared={shared} />;
    return <Text value={JSON.stringify(value)} shared={shared} />;
  }
  const nested = Object.entries(value).filter(([, v]) => !isScalar(v) && !(Array.isArray(v) && v.every(isScalar)));
  return (
    <div data-slate-shape={depth === 0 ? "record" : undefined} className="flex min-w-0 flex-col gap-3">
      <Facts value={value} shared={shared} />
      {nested.map(([key, v]) =>
        depth + 1 >= SHAPE_DEPTH ? (
          <Facts key={key} value={{ [key]: JSON.stringify(v) }} shared={shared} />
        ) : (
          <div key={key} className="flex min-w-0 flex-col gap-1">
            <p className={cn("text-muted-foreground", GROUP_LABEL)}>{wordsOf(key)}</p>
            <ResultByShape value={v} shared={shared} depth={depth + 1} />
          </div>
        ),
      )}
    </div>
  );
}
