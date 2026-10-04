// SPDX-License-Identifier: AGPL-3.0-only
// Bar lists written one after another or held in a grid or row of nothing else (the owner's pick C, 2026-10-05): one
// card holding every list, a segmented control over it naming them, one list shown at a time. Every list stays in the card's one grid cell, the others
// invisible, so the card is the tallest list's height whatever is picked and nothing under it moves on a switch. The
// pick is kept per slate for the window's life, so a value push or a redraw keeps it.
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { SegmentedControl } from "../../components/ui/segmented-control.js";
import { cn } from "../../lib/utils.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import type { SlateEngine } from "../engine.js";
import { PieceHost } from "../SlateView.js";
import { useState } from "react";
import { NOTE, SEGMENT, SEGMENTED, str } from "./look.js";
import { usePiecesVersion } from "./number.js";

const picks = new WeakMap<SlateEngine, Map<string, string>>();

/** Each list's name, the label or title it was given, else its place in the switch. A window every name ends in, such
 * as (15m), is said once beside the control rather than in every segment. */
export function listNames(slate: SlateEngine, ids: readonly string[]): { names: string[]; shared: string | undefined } {
  const given = ids.map(id => {
    const props = slate.piece(id)?.props ?? {};
    return str(slate.resolve(props["label"])) ?? str(slate.resolve(props["title"]));
  });
  const names = given.map((name, at) => (name === undefined || name.trim() === "" ? `List ${at + 1}` : name.trim()));
  const tails = names.map(name => /^(.*\S)\s+\(([^()]+)\)$/.exec(name));
  const tail = tails[0]?.[2];
  if (ids.length < 2 || tail === undefined || !tails.every(match => match?.[2] === tail)) return { names, shared: undefined };
  return { names: tails.map(match => match![1]!), shared: tail };
}

export function BarSwitch({ slate, ids }: { slate: SlateEngine; ids: readonly string[] }) {
  usePiecesVersion(slate, ids);
  const kept = picks.get(slate) ?? new Map<string, string>();
  picks.set(slate, kept);
  const [picked, setPicked] = useState(() => kept.get(ids[0]!) ?? ids[0]!);
  const shown = ids.includes(picked) ? picked : ids[0]!;
  const pick = (id: string) => {
    kept.set(ids[0]!, id);
    setPicked(id);
  };
  const { names, shared } = listNames(slate, ids);
  return (
    <div data-slate-bar-switch className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <ScrollArea hideScrollbars scrollFade className="h-auto min-w-0">
          <SegmentedControl
            aria-label="Lists"
            value={shown}
            segments={ids.map((id, at) => ({ value: id, label: names[at]! }))}
            onChange={pick}
            className={cn(SEGMENTED, "flex-none")}
            segmentClassName={cn(SEGMENT, "whitespace-nowrap")}
          />
        </ScrollArea>
        {shared === undefined ? null : <span data-slate-bar-switch-note className={cn(NOTE, "ml-auto shrink-0 whitespace-nowrap")}>{shared}</span>}
      </div>
      <div className={cn(CARD_SURFACE, "grid min-w-0")}>
        {ids.map(id => (
          <div key={id} data-slate-bar-list={id} aria-hidden={id !== shown || undefined} className={cn("col-start-1 row-start-1 min-w-0", id !== shown && "invisible")}>
            <PieceHost id={id} />
          </div>
        ))}
      </div>
    </div>
  );
}
