// SPDX-License-Identifier: AGPL-3.0-only
// Options to pick one, each a row of the card written to the piece's $value, the question the card's first row. A pick
// before the answer is known puts a check at its row's end; once known, Right on the right row and Wrong on a wrong
// pick, the state word in its tone.
import type { SlateJson } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { getOwn } from "../paths.js";
import { placeOf } from "./runs.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { Check } from "lucide-react";
import { heldBy, present, str } from "./look.js";
import { twoWayPath } from "./press.js";

interface Choice { value: SlateJson; label: string; note: string | undefined }

function choicesOf(value: SlateJson | undefined): Choice[] {
  if (!Array.isArray(value)) return [];
  return value.map(option => {
    if (option !== null && typeof option === "object" && !Array.isArray(option) && "value" in option) {
      return { value: option["value"] ?? null, label: str(option["label"]) ?? str(option["value"]) ?? "", note: str(option["note"]) };
    }
    return { value: option, label: str(option) ?? "", note: undefined };
  });
}

const same = (a: SlateJson | undefined, b: SlateJson | undefined): boolean => a !== undefined && a !== null && JSON.stringify(a) === JSON.stringify(b);

export const choices: PieceView = {
  type: "choices",
  fills: true,
  component: function ChoicesPiece({ id, piece, props, slate, sender, raise }) {
    const path = twoWayPath(piece.props?.["value"]);
    const picked = path === undefined ? props["value"] : getOwn(slate.values, path);
    const answer = props["answer"];
    const held = heldBy(props["held"]);
    const label = str(props["label"]) ?? "";
    const known = picked !== undefined && picked !== null && answer !== undefined && answer !== null;
    const place = placeOf(slate, id);
    const inset = place === "inside" ? "" : "px-(--settings-inset,20px)";
    const options = (
      <div className="flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-border/50">
        {choicesOf(Array.isArray(props["options"]) ? present(slate, piece.props?.["options"], props["options"]) : undefined).map((choice, at) => {
          const chosen = same(choice.value, picked);
          const right = known && same(choice.value, answer);
          const wrong = known && chosen && !right;
          const word = right ? "Right" : wrong ? "Wrong" : undefined;
          return (
            <button
              key={at}
              type="button"
              role="radio"
              aria-checked={chosen}
              data-slate-choice={right ? "right" : wrong ? "wrong" : chosen ? "picked" : "open"}
              disabled={held !== undefined || path === undefined}
              title={held}
              onClick={() => {
                if (path === undefined) return;
                void sender.now(path, choice.value).then(() => (piece.on?.change !== undefined ? raise("change") : undefined));
              }}
              className={cn(
                "flex min-h-11 w-full min-w-0 items-center gap-4 py-3 text-left outline-none transition-colors duration-150",
                inset,
                "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm leading-5 text-foreground">{choice.label}</span>
                {choice.note === undefined ? null : <span className="text-[13px] leading-5 text-muted-foreground">{choice.note}</span>}
              </span>
              {word !== undefined ? (
                <span className={cn("shrink-0 text-[13px] leading-5 font-medium", right ? "text-success" : "text-error-foreground")}>{word}</span>
              ) : chosen ? (
                <Check aria-hidden className="size-3.5 shrink-0 text-foreground" />
              ) : null}
            </button>
          );
        })}
      </div>
    );
    return (
      <div role="radiogroup" aria-label={label} className={cn("flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-border/50", place === "page" && CARD_SURFACE)}>
        {label === "" ? null : <span className={cn("py-3 text-sm leading-5 text-foreground", inset)}>{label}</span>}
        {options}
      </div>
    );
  },
};
