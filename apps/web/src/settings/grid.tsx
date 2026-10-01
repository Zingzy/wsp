// SPDX-License-Identifier: AGPL-3.0-only
// The settings list grammar: a header row whose first cell names the section,
// then the rows on the same column template in the settings pages' one soft
// card, so the columns line up down the page. A row is a glyph frame and a
// sans name with an optional quiet note under it that wraps, numbers in
// right-aligned mono, and a state as a word or the action itself. A row grows
// with what it says.
import { ChevronRightIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils.js";
import { VALUE } from "./format.js";
import { CARD_INSET, LINE_FLOOR, LIST_TITLE, NOTE, ROW_FLOOR } from "./layout.js";
import { CARD_SURFACE } from "./rows.js";

/** The Computers page's template, shared by its two lists so the state column is one line across both. Below
 * 768 px the name, one load, the state and the chevron stand. */
export const LIST_COLUMNS = "grid-cols-[minmax(0,1fr)_56px_72px_64px_100px_14px] max-md:grid-cols-[minmax(0,1fr)_auto_100px_14px]";
/** A computer's or a cloud's page: the name, a version, and the action at the right. */
export const PAGE_COLUMNS = "grid-cols-[minmax(0,1fr)_64px_280px] max-md:grid-cols-[minmax(0,1fr)_auto]";

/** A cell that stands only while the full template does. */
export const WIDE_ONLY = "max-md:hidden";

/** A list: its header row over the card, then the card of rows. */
export function Grid({ id, head, children }: { id: string; head?: ReactNode; children: ReactNode }) {
  return (
    <div data-grid={id} className="flex flex-col">
      {head}
      <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>{children}</div>
    </div>
  );
}

export interface HeadCell {
  readonly word: string;
  readonly num?: boolean;
  readonly wideOnly?: boolean;
}

/** The header row, on the list's template, or on its own where the section's rows are not grid rows. The section's
 * name stands on the card's outer edge like every settings head; the column words sit over their values. */
export function GridHead({ columns, cells }: { columns?: string; cells: readonly HeadCell[] }) {
  return (
    <div data-grid-head className={cn("mb-4 min-h-7 items-end gap-x-4 border-x border-transparent", CARD_INSET, columns === undefined ? "flex" : cn("grid", columns))}>
      {cells.map((cell, at) => (
        <span key={`${at}-${cell.word}`} className={cn("whitespace-nowrap text-sm leading-5 font-normal", at === 0 ? "-ml-[calc(var(--settings-inset,20px)+1px)] text-foreground/70" : "text-muted-foreground", cell.num === true && "text-right", cell.wideOnly === true && WIDE_ONLY)}>
          {cell.word}
        </span>
      ))}
    </div>
  );
}

const ROW = cn("grid items-center gap-x-4 py-3 transition-colors duration-150 hover:bg-accent/60", CARD_INSET);

/** One row. A row that opens a page is the press itself, by pointer or by Enter, and a control inside it keeps its
 * own press. */
export function GridRow({ columns, tight = false, open, onContextMenu, title, attrs, children }: { columns: string; tight?: boolean; open?: () => void; onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void; title?: string; attrs?: Record<string, string>; children: ReactNode }) {
  const opens =
    open === undefined
      ? {}
      : {
          role: "link",
          tabIndex: 0,
          onClick: (event: MouseEvent<HTMLDivElement>) => {
            if (!insideControl(event.target, event.currentTarget)) open();
          },
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              open();
            }
          },
        };
  return (
    <div
      data-grid-row
      className={cn(ROW, columns, tight ? LINE_FLOOR : ROW_FLOOR, open !== undefined && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset")}
      {...(title === undefined ? {} : { title })}
      {...(onContextMenu === undefined ? {} : { onContextMenu })}
      {...opens}
      {...attrs}
    >
      {children}
    </div>
  );
}

/** Whether a press landed on a control of its own inside the row, which the row's open leaves to it. */
const insideControl = (target: EventTarget, row: Element): boolean => target instanceof Element && target.closest("button, a, input") !== null && row.contains(target);

/** The 32 px frame a row's mark stands in. */
export const GLYPH_FRAME = "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-foreground/[0.04]";

export function GlyphFrame({ children }: { children: ReactNode }) {
  return <span className={GLYPH_FRAME}>{children}</span>;
}

/** The first cell: the mark in its frame, the name, an optional tag beside it and an optional note under it. */
export function GridName({ glyph, name, tag, note }: { glyph: ReactNode; name: string; tag?: string; note?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      {glyph}
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span data-grid-name className={cn(LIST_TITLE, "min-w-0 break-words")}>
            {name}
          </span>
          {tag === undefined ? null : (
            <span data-grid-tag className="shrink-0 text-xs text-muted-foreground">
              {tag}
            </span>
          )}
        </span>
        {note === undefined ? null : (
          <span data-grid-note className={NOTE}>
            {note}
          </span>
        )}
      </span>
    </span>
  );
}

/** A number or a version, right-aligned in the mono. */
export function Num({ children, k, wideOnly = false }: { children?: ReactNode; k?: string; wideOnly?: boolean }) {
  return (
    <span {...(k === undefined ? {} : { "data-k": k })} className={cn(VALUE, "min-w-0 truncate text-right", wideOnly && WIDE_ONLY)}>
      {children}
    </span>
  );
}

/** The state: a capitalised word in the muted sans, or the action itself; the whole sentence rides the hover. */
export function StateCell({ word, why, children, className }: { word?: string; why?: string; children?: ReactNode; className?: string }) {
  return (
    <span data-state-cell className={cn("flex min-w-0 items-center justify-end whitespace-nowrap text-[13px] leading-5 tabular-nums text-muted-foreground", className)} {...(why === undefined ? {} : { title: why })}>
      {children ?? word}
    </span>
  );
}

export function Chevron() {
  return <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}


/** The slash between crumbs, at half the muted ink. */
export const Slash = () => (
  <span aria-hidden className="shrink-0 text-muted-foreground/50">
    /
  </span>
);

