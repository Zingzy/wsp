// SPDX-License-Identifier: AGPL-3.0-only
// A state is its word, capitalised, in its tone and weight 500 when toned, never a dot (the design law's State).
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { previousOfType, str, TONE_INK, toneOf } from "./look.js";

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export const status: PieceView = {
  type: "status",
  component: ({ id, props, slate }) => {
    // A status written right after a number rides that number's note.
    if (previousOfType(slate, id, "number") !== undefined) return null;
    const tone = toneOf(props["tone"], slate, id);
    const toned = tone !== "default" && tone !== "muted";
    return (
      <span data-slate-status={tone} className={cn("inline-flex min-w-0 text-[13px] leading-5", toned ? cn(TONE_INK[tone], "font-medium") : "text-muted-foreground")}>
        <span className="truncate">{capitalised(str(props["value"]) ?? "")}</span>
      </span>
    );
  },
};
