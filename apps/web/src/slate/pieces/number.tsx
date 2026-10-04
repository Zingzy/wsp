// SPDX-License-Identifier: AGPL-3.0-only
// A figure in the Usage page's stat cell: its label 13 px muted, the figure 26 px mono, a quiet note under it. A status
// and its follow-on text, right after the number or beside it in its row or cell, ride the note: the state word in its
// tone, then the text, then the number's own note.
import { useMemo, useSyncExternalStore } from "react";
import { DigitRoll } from "../../components/ui/digit-roll.js";
import { cn } from "../../lib/utils.js";
import { STAT } from "../../settings/usage.js";
import type { SlateEngine } from "../engine.js";
import type { PieceView } from "../SlateView.js";
import { figure, str, TONE_INK, toneOf } from "./look.js";
import { isStatCell, ridersOf } from "./riders.js";
import { placeOf } from "./runs.js";

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Redraws when any of these pieces changes; subscribing also keeps them read while they draw nothing themselves. */
function usePiecesVersion(slate: SlateEngine, ids: readonly string[]): string {
  const key = ids.join(" ");
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const offs = key === "" ? [] : key.split(" ").map(id => slate.subscribe(id, listener));
      return () => offs.forEach(off => off());
    },
    [slate, key],
  );
  return useSyncExternalStore(subscribe, () => ids.map(id => slate.pieceVersion(id)).join(" "));
}

export const number: PieceView = {
  type: "number",
  fills: true,
  component: function NumberPiece({ id, props, slate }) {
    const label = str(props["label"]);
    const shown = figure(props["value"], props["format"]);
    const unit = str(props["unit"]);
    const note = str(props["note"]);
    const riders = ridersOf(slate, id);
    usePiecesVersion(slate, riders.all);
    const statePiece = riders.state === undefined ? undefined : slate.piece(riders.state);
    const word = statePiece === undefined ? undefined : str(slate.resolve(statePiece.props?.["value"]));
    const stateTone = statePiece === undefined ? "default" : toneOf(slate.resolve(statePiece.props?.["tone"]), slate, riders.state!);
    const parts = [...riders.texts.map(text => str(slate.resolve(slate.piece(text)?.props?.["value"]))), note].filter((part): part is string => part !== undefined && part !== "");
    // As a row of a card, or the one thing in a row of one, the cell keeps the stat strip's own padding.
    const parent = slate.parentId(id);
    const own = placeOf(slate, id) === "row" || (parent !== undefined && isStatCell(slate, parent) && placeOf(slate, parent) === "row");
    return (
      <div className={cn(STAT.cell, own && "px-(--settings-inset,20px) pt-4 pb-3.5")}>
        <span className={cn(STAT.label, "leading-5")}>{label}</span>
        <span className={cn("flex min-h-8 min-w-0 flex-wrap items-baseline gap-x-1 tabular-nums", STAT.figure, TONE_INK[toneOf(props["tone"], slate, id)])}>
          {shown === undefined ? null : (
            <>
              <DigitRoll value={shown} />
              {unit === undefined ? null : <span data-slate-unit className="font-sans text-xs leading-4 font-normal text-muted-foreground">{unit}</span>}
            </>
          )}
        </span>
        {parts.length === 0 && (word ?? "") === "" ? null : (
          <span className="flex flex-wrap gap-x-3 text-xs leading-4 text-muted-foreground">
            {word === undefined || word === "" ? null : (
              <span data-slate-status={stateTone} className={stateTone === "default" || stateTone === "muted" ? "text-foreground" : cn(TONE_INK[stateTone], "font-medium")}>
                {capitalised(word)}
              </span>
            )}
            {parts.map((part, at) => (
              <span key={at}>{part}</span>
            ))}
          </span>
        )}
      </div>
    );
  },
};
