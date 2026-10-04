// SPDX-License-Identifier: AGPL-3.0-only
// Rows from a list in the settings list grammar: a header over the card whose first cell names the list, the rows in
// the card on one column template shared with the tables beside it, the first text column the row's name taking the
// room, figures 12 px mono at the end, words 13 px muted. With more than two text columns a row folds to its title
// over a note of the rest. One action that every row takes makes the row open, ending in a chevron. Nothing is cut:
// long text wraps and the row grows. Rows are keyed by the piece's `key`, else their index.
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import type { SlateStep } from "../model.js";
import { Button } from "../../components/ui/button.js";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { SECTION_HEAD } from "../../settings/layout.js";
import { cn } from "../../lib/utils.js";
import type { SlateEngine } from "../engine.js";
import type { PieceViewProps, PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { placeOf } from "./runs.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { isSentence, NOTE, present, str, TONE_INK, toneOf } from "./look.js";
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

/** The widest a column stays on one line, in characters of the mono face; anything longer wraps. */
const TIGHT_CH = 26;

/** Each column's tight width in characters, or undefined for a column that wraps: a mono column with no sentence in
 * it, or one whose every cell is a figure, as long as its widest cell fits on one line. */
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
    return widest > TIGHT_CH ? undefined : widest;
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

const NAME = "text-sm leading-5 text-foreground";
const WORD = "text-[13px] leading-5 text-muted-foreground";
const MONO = "font-mono text-xs leading-5 tabular-nums";
const INSET = "px-(--settings-inset,20px)";
const ROW = "min-h-11 py-3 transition-colors duration-150";
const OPENS = "w-full cursor-pointer text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default";

/** A row that opens: the whole row presses the one action every row takes. */
function OpenRow({ id, template, row, raise, className, label, children }: Pick<PieceViewProps, "id" | "raise"> & { template: Template; row: Row; className: string; label: string; children: ReactNode }) {
  const on = template["on"] as unknown as { press?: SlateStep | SlateStep[] } | undefined;
  const { busy, said, refused, press } = usePress(() => raise("press", { row, rowAction: 0, ...(on?.press !== undefined ? { actions: on.press } : {}) }));
  return (
    <div role="row" className="col-span-full grid grid-cols-subgrid">
      <button type="button" data-slate-row-open={`${id}:${row.index}`} disabled={busy} title={pressTitle(on?.press)} aria-label={label} onClick={press} className={cn(className, OPENS)}>
        {children}
      </button>
      {said === undefined && refused === undefined ? null : <span className={cn("col-span-full pb-2", INSET)}><Outcome said={said} refused={refused} /></span>}
    </div>
  );
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
    const place = placeOf(slate, id);
    const inset = place === "inside" ? "" : INSET;
    const card = place === "inside" ? "" : CARD_SURFACE;
    const widths = sharedWidths(slate, id, tightWidths(slate, id));
    const text = widths.flatMap((width, at) => (width === undefined ? [at] : []));
    const cellsOf = (at: number) => shown.map((item, index) => slate.resolve(columns[at]?.["value"], { item, index }));
    const figures = columns.map((_, at) => shown.length > 0 && cellsOf(at).every(isFigure));
    // The row's name: the first text column, or the one most of whose cells are sentences; else the first column.
    const sentences = text.find(at => cellsOf(at).filter(isSentence).length * 2 > shown.length);
    const title = sentences ?? text[0] ?? 0;
    const opens = actions.length === 1 && actions[0]!["when"] === undefined;
    const end = (column: Template, at: number) => at !== title && (column["align"] === "end" || (figures[at] === true && column["align"] === undefined));
    const header = (at: number) => str(slate.resolve(columns[at]?.["title"]));
    const tone = (column: Template, row: Row) => {
      const named = slate.resolve(column["tone"], row);
      return named === undefined ? undefined : TONE_INK[toneOf(named, slate, id)];
    };
    const actionCell = (row: Row) =>
      opens ? (
        <ChevronRight aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" />
      ) : actions.length === 0 ? null : (
        <span role="cell" className="inline-flex justify-end gap-1 self-center">
          {actions.map((template, at) =>
            template["when"] !== undefined && !truthy(slate.resolve({ bind: String(template["when"]) }, row)) ? null : <RowAction key={at} id={id} template={template} at={at} row={row} slate={slate} raise={raise} />,
          )}
        </span>
      );
    const below = (
      <>
        {items.length === 0 ? <p className={cn("flex min-h-11 items-center py-3", WORD, inset, card)}>{str(props["empty"]) ?? "Nothing here"}</p> : null}
        {items.length > shown.length ? <p className={NOTE}>and {items.length - shown.length} more</p> : null}
      </>
    );
    // The note says the words first, then the figures and dates.
    const noteOrder = [...text, ...columns.map((_, at) => at).filter(at => !text.includes(at))];
    if (text.length > 2) {
      // Folded: the name over a note of every other cell, figures and dates in mono, 12 px apart; a section's head names
      // the list, so the column's own header stands only where there is none.
      return (
        <div role="table" aria-label={header(title)} data-slate-folded className="flex min-w-0 flex-col gap-2.5">
          {header(title) === undefined || slate.parent(id)?.type === "section" ? null : <span className={SECTION_HEAD}>{header(title)}</span>}
          {shown.length === 0 ? null : (
            <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] [&>*+*]:border-t [&>*+*]:border-border/50", card)}>
              {shown.map((item, index) => {
                const row = { item, index };
                const name = str(slate.resolve(columns[title]?.["value"], row)) ?? "";
                const body = (
                  <>
                    <span role="cell" className="flex min-w-0 flex-col gap-1">
                      <span className={cn(NAME, "break-words", tone(columns[title]!, row))}>{name}</span>
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        {noteOrder.map(at => {
                          const column = columns[at]!;
                          if (at === title) return null;
                          const value = slate.resolve(column["value"], row);
                          const shownValue = str(value);
                          if (shownValue === undefined || shownValue === "") return null;
                          const mono = (column["mono"] === true && !isSentence(value)) || isFigure(value);
                          return (
                            <span key={at} className={cn("min-w-0 break-words", mono ? cn(MONO, "leading-4 text-muted-foreground") : "text-xs leading-4 text-muted-foreground", tone(column, row))}>
                              {shownValue}
                            </span>
                          );
                        })}
                      </span>
                    </span>
                    {actionCell(row)}
                  </>
                );
                const className = cn("col-span-full grid grid-cols-subgrid items-start gap-x-4", ROW, inset);
                return opens ? (
                  <OpenRow key={rowKey(slate, piece.props?.["key"], row)} id={id} template={actions[0]!} row={row} raise={raise} className={className} label={`${str(slate.resolve(actions[0]!["label"], row)) ?? ""}, ${name}`}>
                    {body}
                  </OpenRow>
                ) : (
                  <div key={rowKey(slate, piece.props?.["key"], row)} role="row" className={className}>
                    {body}
                  </div>
                );
              })}
            </div>
          )}
          {below}
        </div>
      );
    }
    // A grid: the header over the card and every row on one template, the header cells on the rows' own tracks. The
    // card's border and the rows' inset are two edge tracks, so no row pads its subgrid and no track overflows into the
    // next. A figure or machine-text column is as wide as its widest value (its header's included, the tables beside
    // it at the least), so every column stands 16 px off the next.
    const longest = (at: number) => Math.max(str(slate.resolve(columns[at]?.["title"]))?.length ?? 0, ...cellsOf(at).map(cell => str(cell)?.length ?? 0));
    // The column of the longest words or machine text takes the room left, so the last column ends on the right inset
    // however wide the panel.
    const fill = columns.map((_, at) => at).filter(at => !figures[at]).reduce<number | undefined>((best, at) => (best === undefined || longest(at) > longest(best) ? at : best), undefined) ?? title;
    const tight = (at: number) => widths[at] !== undefined && at !== fill;
    const edges = place !== "inside";
    const edge = "calc(var(--settings-inset,20px) - 15px)";
    const tracks = [
      ...(edges ? [edge] : []),
      ...columns.map((_, at) => (at === fill ? "minmax(0,1fr)" : widths[at] !== undefined ? `minmax(${widths[at]}ch,max-content)` : "fit-content(40%)")),
      ...(opens || actions.length > 0 ? ["auto"] : []),
      ...(edges ? [edge] : []),
    ];
    const rim = edges ? <span aria-hidden /> : null;
    return (
      <div role="table" className={cn("grid min-w-0 gap-x-4", MONO)} style={{ gridTemplateColumns: tracks.join(" ") }}>
        {columns.every((_, at) => (header(at) ?? "") === "") ? null : <div role="row" data-slate-head className="col-span-full grid min-h-7 grid-cols-subgrid items-center pb-[5px]">
          {rim}
          {columns.map((column, at) => (
            <span key={at} role="columnheader" data-ch={widths[at]} className={cn(at === 0 ? SECTION_HEAD : WORD, "font-sans", end(column, at) && "text-right", tight(at) && "whitespace-nowrap")}>
              {header(at)}
            </span>
          ))}
          {opens || actions.length > 0 ? <span aria-hidden /> : null}
          {rim}
        </div>}
        {shown.length === 0 ? null : (
          <div className={cn("col-span-full grid grid-cols-subgrid [&>*+*]:border-t [&>*+*]:border-border/50", card)}>
            {shown.map((item, index) => {
              const row = { item, index };
              const body = (
                <>
                  {rim}
                  {columns.map((column, at) => {
                    const value = slate.resolve(column["value"], row);
                    const mono = (column["mono"] === true && !isSentence(value)) || isFigure(value);
                    return (
                      <span
                        key={at}
                        role="cell"
                        className={cn(
                          "min-w-0",
                          mono ? cn(MONO, "text-foreground", !tight(at) && "break-all") : cn(at === title ? NAME : WORD, "break-words font-sans"),
                          tight(at) && "whitespace-nowrap",
                          tone(column, row),
                          end(column, at) && "text-right",
                        )}
                      >
                        {str(value)}
                      </span>
                    );
                  })}
                  {actionCell(row)}
                  {rim}
                </>
              );
              const className = cn("col-span-full grid grid-cols-subgrid items-baseline", ROW);
              return opens ? (
                <OpenRow key={rowKey(slate, piece.props?.["key"], row)} id={id} template={actions[0]!} row={row} raise={raise} className={className} label={`${str(slate.resolve(actions[0]!["label"], row)) ?? ""}, ${str(slate.resolve(columns[title]?.["value"], row)) ?? ""}`}>
                  {body}
                </OpenRow>
              ) : (
                <div key={rowKey(slate, piece.props?.["key"], row)} role="row" className={className}>
                  {body}
                </div>
              );
            })}
          </div>
        )}
        <div className="col-span-full font-sans empty:hidden">{below}</div>
      </div>
    );
  },
};
