// SPDX-License-Identifier: AGPL-3.0-only
// A section is a settings section: a quiet head 10 px over its cards, the section's note at the head's right end, or
// after the title where a chevron folds it, and a refresh glyph while it reads a run on a timer, the cadence on its
// hover, turning while a refresh runs. Its children gather into cards by the one rule in runs.tsx.
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible.js";
import { cn } from "../../lib/utils.js";
import { SECTION_HEAD } from "../../settings/layout.js";
import { RUNS } from "../engine.js";
import { usePieceVersion, type PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { cadenceOf } from "../consent.js";
import { NOTE, str } from "./look.js";
import { twoWayPath } from "./press.js";
import { Runs } from "./runs.js";

const HEAD = cn(SECTION_HEAD, "min-w-0 gap-3");
/** A chart's foot line sits 10 px under it, as the Usage chart's own; a table after other pieces stands 16 px clear. */
const AFTER_CHART = "[&>[data-slate-type=chart]+[data-slate-type=text]]:-mt-0.5 [&>:not(:first-child)[data-slate-type=table]]:mt-1";

export const section: PieceView = {
  type: "section",
  component: function SectionPiece({ id, piece, props, slate, sender, raise }) {
    const title = str(props["title"]);
    const note = str(props["note"]);
    const path = twoWayPath(piece.props?.["open"]);
    // A fold that names no state path is the window's own, kept by piece id while the window lives.
    const [local, setLocal] = useState(() => slate.folds.get(id) ?? (props["open"] === undefined ? true : truthy(props["open"])));
    const open = path !== undefined ? props["open"] === undefined || truthy(props["open"]) : local;
    usePieceVersion(slate, RUNS);
    const refreshing = slate.refreshingUnder(id);
    const timed = slate.timedUnder(id);
    // An open the agent set, literal or two-way, makes the section fold even where it did not say collapsible.
    const folds = props["collapsible"] === true || piece.props?.["open"] !== undefined;
    const head = (
      <>
        <span className="min-w-0 truncate" role="heading" aria-level={3}>{title}</span>
        {folds && note !== undefined ? <span className={cn(NOTE, "min-w-0 truncate")}>{note}</span> : null}
        <span className="flex-1" />
        {!folds && note !== undefined ? <span className={cn(NOTE, "shrink-0 whitespace-nowrap")}>{note}</span> : null}
        {timed.length > 0 || refreshing ? (
          <span data-slate-refresh {...(refreshing ? { "data-slate-refreshing": "" } : {})} title={timed.map(run => cadenceOf(slate.document, run)).join("\n") || undefined} className="-my-0.5 grid size-6 shrink-0 place-items-center rounded-lg text-muted-foreground">
            <RefreshCw aria-hidden className={cn("size-3.5", refreshing && "animate-spin motion-reduce:animate-none")} />
            {refreshing ? <span className="sr-only">Refreshing</span> : null}
          </span>
        ) : null}
      </>
    );
    const body = (
      <div className={cn("flex min-w-0 flex-col gap-3 [&>:empty]:!hidden", AFTER_CHART)}>
        <Runs slate={slate} ids={piece.children ?? []} />
      </div>
    );
    if (!folds) {
      return (
        <section data-slate-section className="flex min-w-0 flex-col gap-2.5">
          <div className={HEAD}>{head}</div>
          {body}
        </section>
      );
    }
    const change = (next: boolean) => {
      if (path !== undefined) void sender.now(path, next);
      else {
        slate.folds.set(id, next);
        setLocal(next);
      }
      if (piece.on?.change !== undefined) void raise("change");
    };
    return (
      <Collapsible data-slate-section open={open} onOpenChange={change} className="flex min-w-0 flex-col">
        <CollapsibleTrigger className={cn(HEAD, "w-full rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring")}>
          {head}
          <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-2.5">{body}</div>
        </CollapsiblePanel>
      </Collapsible>
    );
  },
};
