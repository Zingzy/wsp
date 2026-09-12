// SPDX-License-Identifier: AGPL-3.0-only
// The settings column's grammar, in one place so the page and every section it
// mounts read it from here rather than from each other: a caps mono zone label
// over a section, then one hairline row per pick with its label at the left and
// its control at the right edge, and the mono fact slot a row's numbers go in.
import type { ReactNode } from "react";
import { cn } from "../lib/utils.js";

export const ZONE_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
export const FACT = "font-mono text-[11px] tabular-nums text-muted-foreground";

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className={ZONE_LABEL}>
        {title}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** One pick: its label at the left, its control and the fact beside it at the right edge, a hairline under it. The
 * row is one height by the control's; in a column too narrow for both the control drops under the label, still at
 * the right edge, so the page never scrolls sideways and no word is cut. A fact goes in the slot before the
 * control, which is the one part of the row that gives way: a long line of facts is cut from the right with the
 * whole of it on its title rather than run off the edge. A note is the same row carrying a sentence instead of a
 * pick's name, so a section that has something to say to the reader says it in the column's rhythm. */
export function Row({ id, label, fact, note = false, children }: { id: string; label: string; fact?: ReactNode; note?: boolean; children?: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b border-border/60 py-2 last:border-transparent" data-settings-row>
      <span id={id} className={cn("flex-1", note ? "text-[13px] text-muted-foreground" : "text-sm text-foreground")}>
        {label}
      </span>
      {fact === undefined ? null : <span className="min-w-0 truncate">{fact}</span>}
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}
