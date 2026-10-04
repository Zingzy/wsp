// SPDX-License-Identifier: AGPL-3.0-only
// Rows from a list, one template of columns over them: one header row in the group heading grammar, no line
// between rows, numbers end-aligned in mono. Rows are keyed by the piece's `key`, else their index.
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import type { SlateStep } from "../model.js";
import { Button } from "../../components/ui/button.js";
import { GROUP_LABEL } from "../../lib/microLabel.js";
import { cn } from "../../lib/utils.js";
import type { SlateEngine } from "../engine.js";
import type { PieceViewProps, PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { isSentence, present, str, TONE_INK, toneOf } from "./look.js";
import { Outcome } from "./outcome.js";
import { usePress } from "./press.js";
import { pressTitle } from "./button.js";

type Template = Record<string, SlatePropValue>;
const records = (value: SlatePropValue | undefined): Template[] =>
  Array.isArray(value) ? value.filter((entry): entry is Template => entry !== null && typeof entry === "object" && !Array.isArray(entry)) : [];

type Row = { item: SlateJson; index: number };

/** The columns whose when holds, eight at most. */
const shownColumns = (slate: SlateEngine, raw: SlatePropValue | undefined): Template[] => present(slate, raw, records(raw)).slice(0, 8);

/** A figure as a cell shows it: a number, or text like 524 MB, 12%, $4.20 or 3 days. */
const FIGURE = /^[-+]?[$€£₹¥]?\d[\d,]*(\.\d+)?\s?(%|[A-Za-z]{1,5}(\/s)?)?$/;
const isFigure = (value: SlateJson | undefined): boolean => typeof value === "number" || (typeof value === "string" && FIGURE.test(value.trim()));

function RowAction({ id, template, at, row, slate, raise }: Pick<PieceViewProps, "id" | "slate" | "raise"> & { template: Template; at: number; row: Row }) {
  const on = template["on"] as unknown as { press?: SlateStep | SlateStep[] } | undefined;
  const { busy, said, refused, press } = usePress(() => raise("press", { row, rowAction: at, ...(on?.press !== undefined ? { actions: on.press } : {}) }));
  const label = str(slate.resolve(template["label"], row)) ?? "";
  const first = str(row.item !== null && typeof row.item === "object" && !Array.isArray(row.item) ? Object.values(row.item)[0] : row.item);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button data-slate-row-action={`${id}:${at}`} variant="outline" size="xs" disabled={busy} title={pressTitle(on?.press)} aria-label={first === undefined ? label : `${label}, ${first}`} onClick={press}>
        {label}
      </Button>
      <Outcome said={said} refused={refused} />
    </span>
  );
}

/** The widest a clipped cell draws, in characters of the mono face (max-w-48 at text-xs). */
const CLIP_CH = 26;

/** Each column's tight width in characters, or undefined for a column that wraps: a mono column with no sentence in
 * it, or one whose every cell is a figure. */
function tightWidths(slate: SlateEngine, id: string): (number | undefined)[] {
  const piece = slate.piece(id);
  if (piece === undefined) return [];
  const items = slate.resolve(piece.props?.["items"]);
  const list = Array.isArray(items) ? items : [];
  const cap = slate.resolve(piece.props?.["rows"]);
  const shown = typeof cap === "number" ? list.slice(0, Math.max(0, Math.floor(cap))) : list;
  return shownColumns(slate, piece.props?.["columns"]).map(column => {
    const cells = shown.map((item, index) => slate.resolve(column["value"], { item, index }));
    const mono = column["mono"] === true && !cells.some(isSentence);
    if (!mono && (cells.length === 0 || !cells.every(isFigure))) return undefined;
    const widest = Math.max(str(slate.resolve(column["title"]))?.length ?? 0, ...cells.map(cell => str(cell)?.length ?? 0));
    return Math.min(widest, CLIP_CH);
  });
}

/** The widths this table's tight columns take so the tables beside it with as many columns line up: each column
 * the widest any of them needs. */
function sharedWidths(slate: SlateEngine, id: string, own: (number | undefined)[]): (number | undefined)[] {
  const fellows = slate.tablesBeside(id).filter(other => other !== id).map(other => tightWidths(slate, other)).filter(widths => widths.length === own.length);
  if (fellows.length === 0) return own;
  return own.map((width, at) => (width === undefined ? undefined : Math.max(width, ...fellows.map(widths => widths[at] ?? 0))));
}

function rowKey(slate: SlateEngine, key: SlatePropValue | undefined, row: Row): string {
  const value = key === undefined ? undefined : slate.resolve(key, row);
  return value === undefined || value === null ? `#${row.index}` : typeof value === "string" ? value : JSON.stringify(value);
}

export const table: PieceView = {
  type: "table",
  rowScoped: ["columns", "rowActions", "key"],
  component: function TablePiece({ id, piece, props, slate, raise }) {
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const columns = shownColumns(slate, piece.props?.["columns"]);
    const actions = records(piece.props?.["rowActions"]).slice(0, 3);
    const cap = typeof props["rows"] === "number" ? Math.max(0, Math.floor(props["rows"])) : items.length;
    const shown = items.slice(0, cap);
    const end = (column: Template) => column["align"] === "end";
    // A mono or figure column never wraps: it takes its widest cell, or the widest of the tables beside it, and the
    // text columns wrap around it.
    const widths = sharedWidths(slate, id, tightWidths(slate, id));
    const tight = widths.map(width => width !== undefined);
    // Only a text column can take spare width, and only tables beside others need it to line up; any other table is
    // as wide as what it holds, so its figures stay under their titles.
    const fills = tight.includes(false) && slate.tablesBeside(id).length > 1;
    const figures = columns.map(column => shown.length > 0 && shown.every((item, index) => isFigure(slate.resolve(column["value"], { item, index }))));
    return (
      <div className="min-w-0 overflow-x-auto">
        <table data-fills={fills} className={cn("border-collapse text-left", fills ? "w-full" : "w-auto max-w-full")}>
          <colgroup>
            {widths.map((width, at) => (
              <col key={at} data-ch={width} className="font-mono text-xs" style={width === undefined ? undefined : { width: `calc(${width}ch + 1rem)` }} />
            ))}
            {actions.length > 0 ? <col /> : null}
          </colgroup>
          <thead>
            <tr className={cn("text-muted-foreground", GROUP_LABEL)}>
              {columns.map((column, at) => (
                <th key={at} scope="col" className={cn("pb-1 pr-4 font-normal last:pr-0", (end(column) || (figures[at] && column["align"] === undefined)) && "text-right", tight[at] && "whitespace-nowrap")}>
                  {str(slate.resolve(column["title"]))}
                </th>
              ))}
              {actions.length > 0 ? <th aria-label="Actions" className="pb-1" /> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((item, index) => {
              const row = { item, index };
              return (
                <tr key={rowKey(slate, piece.props?.["key"], row)} className="align-top transition-colors duration-150 hover:bg-accent">
                  {columns.map((column, at) => {
                    const value = slate.resolve(column["value"], row);
                    const mono = (column["mono"] === true && !isSentence(value)) || isFigure(value);
                    const text = str(value);
                    return (
                      <td
                        key={at}
                        className={cn(
                          "py-1 pr-4 last:pr-0",
                          mono ? "font-mono text-xs leading-5 tabular-nums" : "text-[13px] leading-5",
                          tight[at] && "whitespace-nowrap",
                          TONE_INK[toneOf(slate.resolve(column["tone"], row), slate, id)],
                          (end(column) || (isFigure(value) && column["align"] === undefined)) && "text-right",
                        )}
                      >
                        {tight[at] && !isFigure(value) ? <span data-k="clip" title={text} className="block max-w-48 truncate">{text}</span> : text}
                      </td>
                    );
                  })}
                  {actions.length > 0 ? (
                    <td className="py-1 text-right">
                      <span className="inline-flex gap-1">
                        {actions.map((template, at) =>
                          template["when"] !== undefined && !truthy(slate.resolve({ bind: String(template["when"]) }, row)) ? null : (
                            <RowAction key={at} id={id} template={template} at={at} row={row} slate={slate} raise={raise} />
                          ),
                        )}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 ? <p className="py-1 text-[13px] leading-5 text-muted-foreground">{str(props["empty"]) ?? "Nothing here"}</p> : null}
        {items.length > shown.length ? <p className="py-1 text-xs leading-4 text-muted-foreground">and {items.length - shown.length} more</p> : null}
      </div>
    );
  },
};
