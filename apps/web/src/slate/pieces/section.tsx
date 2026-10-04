// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible.js";
import { cn } from "../../lib/utils.js";
import { RUNS } from "../engine.js";
import { usePieceVersion, type PieceView } from "../SlateView.js";
import { truthy } from "../actions.js";
import { Refreshing } from "./refreshing.js";
import { SlateIcon } from "./icon.js";
import { groupLook, str } from "./look.js";
import { twoWayPath } from "./press.js";

const HEAD = "flex h-7 min-w-0 items-center gap-1 text-sm text-foreground/70";

export const section: PieceView = {
  type: "section",
  component: function SectionPiece({ id, piece, props, slate, sender, raise, children }) {
    const title = str(props["title"]);
    const note = str(props["note"]);
    const path = twoWayPath(piece.props?.["open"]);
    // A fold that names no state path is the window's own, kept by piece id while the window lives.
    const [local, setLocal] = useState(() => slate.folds.get(id) ?? (props["open"] === undefined ? true : truthy(props["open"])));
    const open = path !== undefined ? props["open"] === undefined || truthy(props["open"]) : local;
    usePieceVersion(slate, RUNS);
    const refreshing = slate.refreshingUnder(id);
    const head = (
      <>
        <SlateIcon name={props["icon"]} className="mr-1 size-3.5" />
        <span className="min-w-0 truncate" role="heading" aria-level={3}>{title}</span>
        {note === undefined ? null : <span className="ml-2 truncate text-xs text-muted-foreground">{note}</span>}
        {refreshing ? <Refreshing className="ml-2" /> : null}
      </>
    );
    // An open the agent set, literal or two-way, makes the section fold even where it did not say collapsible.
    if (props["collapsible"] !== true && piece.props?.["open"] === undefined) {
      return (
        <section data-slate-section className="flex min-w-0 flex-col gap-2.5">
          <div className={HEAD}>{head}</div>
          <div className={cn("flex min-w-0 flex-col gap-2", groupLook(props))}>{children}</div>
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
        <CollapsibleTrigger className={cn(HEAD, "w-full rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring")}>
          {head}
          <ChevronRight aria-hidden className={cn("ml-auto size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className={cn("mt-2.5 flex min-w-0 flex-col gap-2", groupLook(props))}>{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    );
  },
};
