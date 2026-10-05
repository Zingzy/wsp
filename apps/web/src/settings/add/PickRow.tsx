// SPDX-License-Identifier: AGPL-3.0-only
// A row a person ticks, in the settings list grammar: the checkbox, the mark
// in its 32 px frame, the name with a mono tag and a quiet note that wraps,
// and at the right the one control or fact. Below 640 px the control stands
// under the words. What a tick opens (a project's name, icon and colour)
// stands under the row inside the same card, its labels on the name's edge.
import type { ReactNode } from "react";
import { Checkbox } from "../../components/ui/checkbox.js";
import { cn } from "../../lib/utils.js";
import { FACT } from "../format.js";
import { GlyphFrame } from "../grid.js";
import { CARD_INSET, LIST_TITLE, NOTE, ROW_FLOOR } from "../layout.js";

/** The checkbox, its gap, the frame and its gap: where the name starts, and where what a tick opens lines up. */
export const PICK_TEXT_EDGE = "pl-[calc(var(--settings-inset,20px)+72px)]";

export function PickRow({
  id,
  checked,
  onCheckedChange,
  glyph,
  name,
  tag,
  marks,
  note,
  slot,
  children,
}: {
  id: string;
  checked: boolean;
  onCheckedChange?: (next: boolean) => void;
  glyph: ReactNode;
  name: string;
  /** A version or a path, in the mono after the name. */
  tag?: string;
  /** The marks of the agents a thing is set up for, after the name. */
  marks?: ReactNode;
  note?: string;
  /** One control or one fact at the right. */
  slot?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-pick-row={id} data-checked={checked} className="flex flex-col">
      <label className={cn("flex cursor-pointer flex-col justify-center gap-3 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-5", CARD_INSET, ROW_FLOOR)}>
        <span className="flex min-w-0 items-center gap-3">
          <Checkbox checked={checked} {...(onCheckedChange === undefined ? {} : { onCheckedChange })} className="shrink-0" />
          <GlyphFrame>{glyph}</GlyphFrame>
          <span className={cn("flex min-w-0 flex-col", !checked && "text-muted-foreground")}>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span data-pick-name className={cn(LIST_TITLE, "min-w-0 break-words", !checked && "text-muted-foreground")}>
                {name}
              </span>
              {tag === undefined ? null : <span className={cn(FACT, "shrink-0")}>{tag}</span>}
              {marks}
            </span>
            {note === undefined ? null : (
              <span data-pick-note className={NOTE}>
                {note}
              </span>
            )}
          </span>
        </span>
        {slot === undefined ? null : (
          <span data-pick-slot className="flex min-w-0 shrink-0 items-center gap-3 max-sm:pl-[72px] sm:justify-end" onClick={event => event.preventDefault()}>
            {slot}
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

/** One line under a ticked row: its label on the name's edge and its control at the right, 48 px tall. */
export function PickLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-pick-line className={cn("flex min-h-12 items-center justify-between gap-5 border-t border-border/50 py-2 pr-(--settings-inset,20px)", PICK_TEXT_EDGE)}>
      <span className="text-sm leading-5 text-foreground">{label}</span>
      <span className="flex shrink-0 items-center">{children}</span>
    </div>
  );
}
