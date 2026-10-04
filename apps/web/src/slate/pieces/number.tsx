// SPDX-License-Identifier: AGPL-3.0-only
import { DigitRoll } from "../../components/ui/digit-roll.js";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { figure, str, TONE_INK, toneOf } from "./look.js";

export const number: PieceView = {
  type: "number",
  component: ({ id, props, slate }) => {
    const label = str(props["label"]);
    const shown = figure(props["value"], props["format"]);
    const unit = str(props["unit"]);
    const note = str(props["note"]);
    const large = props["size"] === "large" && slate.isLoud("large", id);
    return (
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] leading-5 text-muted-foreground">{label}</span>
        <span className={cn("min-h-5 font-mono tabular-nums", large ? "text-lg leading-7 tracking-[-0.01em]" : "text-sm leading-5", TONE_INK[toneOf(props["tone"], slate, id)])}>
          {shown === undefined ? null : (
            <>
              <DigitRoll value={shown} />
              {unit === undefined ? null : <span className="ml-1 text-muted-foreground">{unit}</span>}
            </>
          )}
        </span>
        {note === undefined ? null : <span className="text-[11px] leading-4 text-muted-foreground">{note}</span>}
      </div>
    );
  },
};
