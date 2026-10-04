// SPDX-License-Identifier: AGPL-3.0-only
// Large options to pick one, each a full-width press written to the piece's $value. Once picked, an answer marks
// the right option good and a wrong pick bad.
import type { SlateJson } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { getOwn } from "../paths.js";
import { heldBy, str } from "./look.js";
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
  component: function ChoicesPiece({ piece, props, slate, sender, raise }) {
    const path = twoWayPath(piece.props?.["value"]);
    const picked = path === undefined ? props["value"] : getOwn(slate.values, path);
    const answer = props["answer"];
    const held = heldBy(props["held"]);
    const label = str(props["label"]) ?? "";
    const known = picked !== undefined && picked !== null && answer !== undefined && answer !== null;
    return (
      <div role="radiogroup" aria-label={label} className="flex min-w-0 flex-col gap-2">
        <span className="text-sm leading-5 text-foreground">{label}</span>
        {choicesOf(props["options"]).map((choice, at) => {
          const chosen = same(choice.value, picked);
          const right = known && same(choice.value, answer);
          const wrong = known && chosen && !right;
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
                "flex min-h-11 w-full min-w-0 flex-col items-start justify-center rounded-lg border border-input bg-input-fill px-4 py-2.5 text-left outline-none transition-colors duration-150",
                "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-input-fill motion-reduce:transition-none",
                chosen && !known && "border-primary",
                right && "border-success",
                wrong && "border-error-foreground",
              )}
            >
              <span className={cn("text-sm leading-5 text-foreground", right && "text-success", wrong && "text-error-foreground", (right || wrong) && "font-medium")}>{choice.label}</span>
              {choice.note === undefined ? null : <span className="text-xs leading-4 text-muted-foreground">{choice.note}</span>}
            </button>
          );
        })}
      </div>
    );
  },
};
