// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import type { SlateEngine } from "../engine.js";
import { isSentence, str, TONE_INK, toneOf } from "./look.js";
import { riddenBy } from "./riders.js";

/** A row with a heading and a button in it: a text beside them is a status line, small and muted. */
function inHeaderRow(slate: SlateEngine, id: string): boolean {
  const row = slate.parent(id);
  if (row?.type !== "row") return false;
  const types = (row.children ?? []).map(child => slate.piece(child)?.type);
  return types.includes("heading") && types.includes("button");
}

export const text: PieceView = {
  type: "text",
  component: ({ id, piece, props, slate }) => {
    // A text following a status beside a number rides that number's note.
    if (riddenBy(slate, id) !== undefined) return null;
    const value = str(props["value"]);
    const placeholder = str(props["placeholder"]);
    if (value === undefined || value === "") {
      return placeholder === undefined ? null : <p className="text-xs leading-4 text-muted-foreground">{placeholder}</p>;
    }
    const emphasis = props["emphasis"];
    const set = piece.props ?? {};
    const status = set["size"] === undefined && set["tone"] === undefined && set["emphasis"] === undefined && inHeaderRow(slate, id);
    // Small is the 12 px note, quiet and muted the 13 px quiet step, both in the muted ink whatever face they asked for.
    const small = status || props["size"] === "small";
    const quiet = !small && (emphasis === "quiet" || props["tone"] === "muted");
    const large = !small && !quiet && props["size"] === "large" && slate.isLoud("large", id);
    const mono = props["mono"] === true && !small && !isSentence(value);
    const tone = toneOf(props["tone"], slate, id);
    const toned = !small && !quiet && tone !== "default" && tone !== "muted";
    return (
      <p
        className={cn(
          "min-w-0 whitespace-pre-wrap break-words",
          small ? "text-xs leading-4 text-muted-foreground" : quiet ? "max-w-xl text-[13px] leading-[1.45] text-muted-foreground" : toned ? "text-[13px] leading-5 font-medium" : large ? "text-[15px] leading-[22px]" : mono ? "text-[13px] leading-5" : "text-sm leading-5",
          !small && !quiet && TONE_INK[tone],
          emphasis === "strong" && "font-medium",
          mono && "font-mono tabular-nums",
          typeof props["value"] === "number" && "tabular-nums",
        )}
      >
        {value}
      </p>
    );
  },
};
