// SPDX-License-Identifier: AGPL-3.0-only
// The settings list grammar: a header row whose first cell names the section,
// then rows on the same column template so the columns line up down the page.
// A row is a glyph frame and a sans name with an optional quiet note under it,
// numbers in right-aligned mono, and a state as a word or the action itself. No rule under the header, none between rows, no box
// around the list: space groups them. The list is pulled out by the rows'
// padding, so glyph frames start on the page's left edge.
import { ChevronRightIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { VALUE } from "./format.js";

/** The Computers page's template, shared by its two lists so the state column is one line across both. Below
 * 768 px the name, one load, the state and the chevron stand. */
export const LIST_COLUMNS = "grid-cols-[minmax(0,1fr)_48px_64px_140px_100px_14px] max-md:grid-cols-[minmax(0,1fr)_auto_100px_14px]";
/** A computer's or a cloud's page: the name, a version, and the action at the right. */
export const PAGE_COLUMNS = "grid-cols-[minmax(0,1fr)_64px_280px] max-md:grid-cols-[minmax(0,1fr)_auto]";

/** A cell that stands only while the full template does. */
export const WIDE_ONLY = "max-md:hidden";

export function Grid({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-grid={id} className="-mx-2 flex flex-col gap-0.5">
      {children}
    </div>
  );
}

export interface HeadCell {
  readonly word: string;
  readonly num?: boolean;
  readonly wideOnly?: boolean;
}

/** The header row, on the list's template, or on its own where the section's rows are not grid rows. */
export function GridHead({ columns, cells }: { columns?: string; cells: readonly HeadCell[] }) {
  return (
    <div data-grid-head className={cn("mb-0.5 h-6 items-center gap-x-4 px-2", columns === undefined ? "flex" : cn("grid", columns))}>
      {cells.map((cell, at) => (
        <span key={`${at}-${cell.word}`} className={cn(GROUP_LABEL, "whitespace-nowrap text-muted-foreground", cell.num === true && "text-right", cell.wideOnly === true && WIDE_ONLY)}>
          {cell.word}
        </span>
      ))}
    </div>
  );
}

const ROW = "grid items-center gap-x-4 rounded-lg px-2 transition-colors duration-150 hover:bg-accent";

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
      className={cn(ROW, columns, tight ? "h-12" : "h-13", open !== undefined && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset")}
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
          <span data-grid-name className="truncate text-sm leading-5 text-foreground">
            {name}
          </span>
          {tag === undefined ? null : (
            <span data-grid-tag className="shrink-0 text-xs text-muted-foreground">
              {tag}
            </span>
          )}
        </span>
        {note === undefined ? null : (
          <span data-grid-note className="truncate text-[11px] leading-[14px] text-muted-foreground" title={note}>
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

/** A page's head at the list's left edge: the crumbs on a page under a group, the title, then the blurb or the
 * state line. */
export function PageHead({ crumbs, title, children }: { crumbs?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <header data-k="settings-page-head" className="flex flex-col gap-1.5 pb-2">
      {crumbs}
      <h1 className="text-lg leading-7 font-medium">{title}</h1>
      {children}
    </header>
  );
}

/** The slash between crumbs, at half the muted ink. */
export const Slash = () => (
  <span aria-hidden className="shrink-0 text-muted-foreground/50">
    /
  </span>
);

/** The crumbs over a computer's page title: its group as the way back to the list, then the page itself. */
export function PageCrumbs({ group, page, onGroup }: { group: string; page: string; onGroup: () => void }) {
  return (
    <nav data-k="page-crumbs" className="mb-1 flex min-w-0 items-center gap-2 text-[13px]">
      <button type="button" data-k="page-crumbs-group" className="cursor-pointer text-muted-foreground transition-colors duration-150 hover:text-foreground" onClick={onGroup}>
        {group}
      </button>
      <Slash />
      <span className="truncate text-foreground">{page}</span>
    </nav>
  );
}
