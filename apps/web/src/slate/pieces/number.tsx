// SPDX-License-Identifier: AGPL-3.0-only
// A figure in the Usage page's stat cell: its label 13 px muted, the figure 26 px mono, a quiet note under it. A
// status written right after the number rides the note as its state word, in its tone, before the note's sentence.
import { DigitRoll } from "../../components/ui/digit-roll.js";
import { cn } from "../../lib/utils.js";
import { STAT } from "../../settings/usage.js";
import type { SlateEngine } from "../engine.js";
import { usePieceVersion, type PieceView } from "../SlateView.js";
import { figure, nextOfType, str, TONE_INK, toneOf } from "./look.js";
import { placeOf } from "./runs.js";

/** A grid whose every child is a number: Usage's stat strip. */
export function isStrip(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  const children = piece?.children ?? [];
  return piece?.type === "grid" && children.length > 0 && children.every(child => slate.piece(child)?.type === "number");
}

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export const number: PieceView = {
  type: "number",
  fills: true,
  component: function NumberPiece({ id, props, slate }) {
    const label = str(props["label"]);
    const shown = figure(props["value"], props["format"]);
    const unit = str(props["unit"]);
    const note = str(props["note"]);
    const state = nextOfType(slate, id, "status");
    usePieceVersion(slate, state ?? id);
    const statePiece = state === undefined ? undefined : slate.piece(state);
    const word = statePiece === undefined ? undefined : str(slate.resolve(statePiece.props?.["value"]));
    const stateTone = statePiece === undefined ? "default" : toneOf(slate.resolve(statePiece.props?.["tone"]), slate, state!);
    // As a row of a card the cell keeps the stat strip's own padding; in a strip or inside another row it takes theirs.
    return (
      <div className={cn(STAT.cell, placeOf(slate, id) === "row" && "px-(--settings-inset,20px) pt-4 pb-3.5")}>
        <span className={cn(STAT.label, "leading-5")}>{label}</span>
        <span className={cn("min-h-8 break-words tabular-nums", STAT.figure, TONE_INK[toneOf(props["tone"], slate, id)])}>
          {shown === undefined ? null : (
            <>
              <DigitRoll value={shown} />
              {unit === undefined ? null : <span className="ml-1.5 font-sans text-[13px] font-normal text-muted-foreground">{unit}</span>}
            </>
          )}
        </span>
        {note === undefined && word === undefined ? null : (
          <span className="flex flex-wrap gap-x-3 text-xs leading-4 text-muted-foreground">
            {word === undefined || word === "" ? null : (
              <span data-slate-status={stateTone} className={stateTone === "default" || stateTone === "muted" ? "text-foreground" : cn(TONE_INK[stateTone], "font-medium")}>
                {capitalised(word)}
              </span>
            )}
            {note === undefined ? null : <span>{note}</span>}
          </span>
        )}
      </div>
    );
  },
};
