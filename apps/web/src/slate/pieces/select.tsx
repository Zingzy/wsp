// SPDX-License-Identifier: AGPL-3.0-only
// One choice of a few, written to a value: options from a bound list of strings or of { value, label }.
import type { SlateJson } from "@wsp/protocol";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import type { PieceView } from "../SlateView.js";
import { getOwn } from "../paths.js";
import { heldBy, present, str } from "./look.js";
import { twoWayPath } from "./press.js";

function optionsOf(value: SlateJson | undefined): { value: string; label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(option => {
    if (typeof option === "string" || typeof option === "number") return [{ value: String(option), label: String(option) }];
    if (option === null || typeof option !== "object" || Array.isArray(option)) return [];
    const v = str(option["value"]);
    return v === undefined ? [] : [{ value: v, label: str(option["label"]) ?? v }];
  });
}

export const select: PieceView = {
  type: "select",
  component: function SelectPiece({ piece, props, slate, sender, raise }) {
    const path = twoWayPath(piece.props?.["value"]);
    const options = optionsOf(Array.isArray(props["options"]) ? present(slate, piece.props?.["options"], props["options"]) : undefined);
    const current = str(path === undefined ? props["value"] : getOwn(slate.values, path)) ?? null;
    const label = str(props["label"]) ?? "";
    const held = heldBy(props["held"]);
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[13px] leading-5 text-foreground">{label}</span>
        <Select
          value={current}
          disabled={held !== undefined || path === undefined}
          onValueChange={next => {
            if (path === undefined || typeof next !== "string") return;
            void sender.now(path, next).then(() => (piece.on?.change !== undefined ? raise("change") : undefined));
          }}
        >
          <SelectTrigger size="sm" aria-label={label} title={held}>
            <SelectValue placeholder={str(props["placeholder"]) ?? "Pick one"}>{(value: string | null) => options.find(o => o.value === value)?.label ?? value}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {options.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    );
  },
};
